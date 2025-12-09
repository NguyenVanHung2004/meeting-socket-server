require('dotenv').config();
const { Server } = require("socket.io");
const speech = require("@google-cloud/speech");
const path = require("path");
const fs = require("fs");
const http = require("http");

const PORT = process.env.PORT || 8080;
const KEY_FILE_PATH = path.join(__dirname, "google-key.json");

if (!fs.existsSync(KEY_FILE_PATH)) {
    console.error("❌ LỖI: Không tìm thấy file google-key.json!");
}

const speechClient = new speech.SpeechClient({
  keyFilename: KEY_FILE_PATH
});

const httpServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Socket Server is Running!');
});

const io = new Server(httpServer, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8
});

console.log(`🚀 Socket Server đang chạy trên cổng ${PORT}`);

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  
  let recognizeStream = null;
  let restartTimeout = null;
  let savedRequest = null; // Biến để lưu cấu hình, dùng cho việc restart

  // --- HÀM KHỞI TẠO STREAM (Tách riêng để gọi lại) ---
  const startStream = () => {
    // 1. Dọn dẹp stream cũ (nếu có)
    if (recognizeStream) {
        recognizeStream.end();
        recognizeStream.removeAllListeners();
        recognizeStream = null;
    }
    if (restartTimeout) clearTimeout(restartTimeout);

    console.log("🔄 (Re)Starting Google Stream...");

    // 2. Tạo Stream mới
    recognizeStream = speechClient
      .streamingRecognize(savedRequest)
      .on("error", (err) => {
        // Nếu gặp lỗi quá hạn 305s (mã 11) -> Tự restart luôn
        if (err.code === 11 || err.toString().includes("Exceeded maximum allowed stream duration")) {
            console.warn("⚠️ Gặp lỗi giới hạn thời gian (305s), đang tự khởi động lại...");
            startStream();
        } else {
            console.error("Google API Error:", err);
            socket.emit("google-error", err.message);
        }
      })
      .on("data", (data) => {
        const result = data.results[0];
        if (result && result.alternatives[0]) {
            const transcript = result.alternatives[0].transcript;
            const isFinal = result.isFinal;
            
            let speaker = 0;
            const words = result.alternatives[0].words;
            if (isFinal && words && words.length > 0) {
                // Lấy speaker tag của từ cuối cùng cho chắc ăn
                for (let i = words.length - 1; i >= 0; i--) {
                    if (words[i].speakerTag) {
                        speaker = words[i].speakerTag;
                        break;
                    }
                }
            }
           
            socket.emit("transcript-data", { 
                text: transcript, 
                isFinal, 
                speaker 
            });
        }
      });

    // 3. Đặt hẹn giờ "Tự sát" sau 290 giây (để né giới hạn 305 giây)
    restartTimeout = setTimeout(() => {
        console.log("⏰ Đã đến giới hạn an toàn (290s). Đang tái khởi động stream...");
        startStream();
    }, 290000); 
  };

  // --- XỬ LÝ SỰ KIỆN TỪ CLIENT ---

  socket.on("start-google-stream", () => {
    console.log("🎙️ Client yêu cầu bắt đầu ghi âm.");

    // Lưu cấu hình vào biến global của socket này
    savedRequest = {
      config: {
        encoding: "WEBM_OPUS",
        sampleRateHertz: 48000,
        languageCode: "vi-VN",
        alternativeLanguageCodes: ["en-US"], 
        enableSpeakerDiarization: true,
        diarizationConfig: {
          minSpeakerCount: 1,
          maxSpeakerCount: 5,
        },
        model: "latest_long",
        // model: "default", // Bạn có thể đổi về default nếu thấy latest_long bị chậm
        useEnhanced: true,
        enableWordTimeOffsets: true,
        
        // Metadata giúp Google hiểu ngữ cảnh (quan trọng)
        metadata: {
            interactionType: "PRESENTATION", // Hoặc DISCUSSION
            microphoneDistance: "NEARFIELD", // Mic gần (Laptop/Tai nghe)
            originalMediaType: "AUDIO",
            recordingDeviceType: "PC",
        },
      },
      interimResults: true,
    };

    // Gọi hàm bắt đầu
    startStream();
  });

  socket.on("audio-chunk", (data) => {
    // Chỉ ghi nếu stream đang mở và chưa bị hủy
    if (recognizeStream && !recognizeStream.destroyed) {
        try {
            recognizeStream.write(data);
        } catch (err) {
            // Lỗi này thường xảy ra đúng lúc đang restart, bỏ qua được
            // console.warn("⚠️ Lỗi ghi audio vào stream (đang restart?):", err.message);
        }
    }
  });

  socket.on("stop-google-stream", () => {
    if (restartTimeout) clearTimeout(restartTimeout);
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
      console.log("🛑 Client dừng ghi âm.");
    }
  });

  // ... (Phần xử lý Batch Analyze giữ nguyên code cũ của bạn) ...
   socket.on("google-batch-analyze", async (fileBuffer) => {
    console.log(`📥 Nhận yêu cầu Batch: ${fileBuffer.length} bytes`);

    try {
      const audio = {
        content: fileBuffer.toString("base64"), // Google cần Base64
      };

      const config = {
        encoding: "WEBM_OPUS",
        sampleRateHertz: 48000,
        languageCode: "vi-VN",
        alternative_language_codes: ["en-US"],
        model: "latest_long", // Batch thì dùng model xịn nhất
        enableSpeakerDiarization: true, // ✅ Batch HỖ TRỢ cái này!
        diarizationConfig: {
          minSpeakerCount: 1, // Tự động đoán số người
          maxSpeakerCount: 5,
        },
      };

      const request = {
        audio: audio,
        config: config,
      };

      // Dùng longRunningRecognize cho file dài (> 1 phút)
      const [operation] = await speechClient.longRunningRecognize(request);
      console.log("⏳ Đang xử lý Batch... (Vui lòng đợi)");

      const [response] = await operation.promise();
      
      // Xử lý kết quả trả về
      const result = response.results
        .map(res => {
            // Lấy từ cuối cùng (đầy đủ nhất) của mỗi đoạn
            const alt = res.alternatives[0];
            if (!alt.words || alt.words.length === 0) return "";
            
            // Gom nhóm các từ theo Speaker
            let transcript = "";
            let currentSpeaker = -1;
            
            alt.words.forEach(word => {
                const spk = word.speakerTag;
                if (spk !== currentSpeaker) {
                    transcript += `\n[Speaker ${spk}]: ${word.word}`;
                    currentSpeaker = spk;
                } else {
                    transcript += ` ${word.word}`;
                }
            });
            return transcript;
        })
        .join("\n");

      console.log("✅ Batch hoàn tất!");
      console.log("📝 KẾT QUẢ BATCH:\n", result);
      socket.emit("batch-complete", result);

    } catch (err) {
      console.error("❌ Lỗi Batch:", err);
      socket.emit("google-error", "Lỗi xử lý Batch: " + err.message);
    }
  });

  socket.on("disconnect", () => {
    if (restartTimeout) clearTimeout(restartTimeout);
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
    }
    console.log("Client disconnected:", socket.id);
  });
});

httpServer.listen(PORT);