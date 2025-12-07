require('dotenv').config();
const { Server } = require("socket.io");
const speech = require("@google-cloud/speech");
const path = require("path"); // Thêm thư viện này để xử lý đường dẫn file chính xác
const fs = require("fs");
const http = require("http"); // Thêm cái này để tạo server http chuẩn
// [QUAN TRỌNG] Render sẽ cấp PORT qua biến môi trường, nếu không có thì dùng 8080
const PORT = process.env.PORT || 8080;

const KEY_FILE_PATH = path.join(__dirname, "google-key.json");

// Kiểm tra xem file key có tồn tại không (để debug)
if (!fs.existsSync(KEY_FILE_PATH)) {
    console.error("❌ LỖI: Không tìm thấy file google-key.json!");
}
// --- SỬA ĐOẠN NÀY ---
// Thay vì đọc từ env, ta đọc thẳng từ file json
const speechClient = new speech.SpeechClient({
  keyFilename: KEY_FILE_PATH
});

// Tạo HTTP Server (Render cần cái này để Health Check)
const httpServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Socket Server is Running!');
});


const io = new Server(httpServer, { // Gắn socket vào httpServer
  cors: {
    // Cho phép Frontend của bạn kết nối. 
    // Khi deploy Frontend, hãy thay dấu "*" bằng domain thật để bảo mật.
    origin: "*", 
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8
});

console.log(`🚀 Socket Server đang chạy trên cổng ${PORT}`);

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  let recognizeStream = null;

  socket.on("start-google-stream", () => {
    console.log("🎙️ Bắt đầu stream Google..."); // Log để biết có chạy vào đây không

    const request = {
      config: {
        encoding: "WEBM_OPUS", // Giữ nguyên WEBM_OPUS để khớp với Client
        sampleRateHertz: 48000,
        languageCode: "vi-VN",
        
        // 1. ✅ BẬT LẠI DIARIZATION (Theo ý bạn)
        enableSpeakerDiarization: true,
        diarizationConfig: {
          minSpeakerCount: 1,
          maxSpeakerCount: 5,
        },

        // 2. ✅ ĐỔI MODEL: Dùng "default" thay vì "latest_long"
        // "latest_long" rất chính xác nhưng xử lý rất nặng, dễ gây timeout khi bật Diarization.
        // "default" (hoặc "command_and_search") phản hồi nhanh hơn, giúp giảm rớt chữ.
        model: "latest_long",
        enableWordTimeOffsets: true, 
      },
      interimResults: true,
    };

    recognizeStream = speechClient
      .streamingRecognize(request)
      .on("error", (err) => {
        console.error("Google API Error:", err);
        socket.emit("google-error", err.message);
      })
      .on("data", (data) => {
        console.log("📦 RAW DATA:", JSON.stringify(data, null, 2));
        const result = data.results[0];
        if (result && result.alternatives[0]) {
            const transcript = result.alternatives[0].transcript;
            const isFinal = result.isFinal;
            
            let speaker = 0;
            const words = result.alternatives[0].words;
            // ✅ MỚI: Quét tất cả các từ trong câu, thấy có tag là lấy luôn
            if (isFinal && words.length > 0) {
                for (const word of words) {
                    if (word.speakerTag) {
                        speaker = word.speakerTag;
                        break; // Tìm thấy rồi thì dừng
                    }
                }
            }
           
                console.log(`📝 Final Text: "${transcript}" | 🗣️ Speaker Tag: ${speaker}`);         
            // Gửi lại cho Client
            socket.emit("transcript-data", { text: transcript, isFinal, speaker });
        }
      });
  });

  socket.on("audio-chunk", (data) => {
    // ❌ CŨ: if (recognizeStream) {
    
    // ✅ MỚI: Kiểm tra thêm điều kiện stream chưa bị hủy (destroyed)
    if (recognizeStream && !recognizeStream.destroyed) {
        try {
            recognizeStream.write(data);
        } catch (err) {
            // Nếu lỡ có lỗi thì bỏ qua luôn, vì đằng nào cũng đang dừng rồi
            console.warn("⚠️ Bỏ qua gói tin cuối do stream đã đóng.");
        }
    }
  });

  socket.on("stop-google-stream", () => {
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
      console.log("🛑 Đã dừng stream.");
    }
  });
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
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
    }
    console.log("Client disconnected:", socket.id);
  });
});

console.log(`🚀 Socket Server đang chạy trên cổng ${PORT}`);
httpServer.listen(PORT); // Đổi thành httpServer.listen