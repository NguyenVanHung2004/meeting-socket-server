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
    let savedRequest = null; 
    let webmHeader = null; // [MỚI] Biến để lưu Header của file WebM

    // --- HÀM KHỞI TẠO STREAM (Cơ chế Hot-Swap) ---
    const startStream = () => {
        console.log("🔄 (Re)Starting Google Stream...");

        // 1. Dọn dẹp stream cũ
        if (recognizeStream) {
            recognizeStream.end();
            recognizeStream.removeAllListeners();
            recognizeStream = null;
        }
        if (restartTimeout) clearTimeout(restartTimeout);

        // 2. Tạo Stream mới
        recognizeStream = speechClient
            .streamingRecognize(savedRequest)
            .on("error", (err) => {
                if (err.code === 11 || err.toString().includes("Exceeded maximum allowed stream duration")) {
                    console.warn("⚠️ Google Stream hết hạn. Đang tái khởi động...");
                    startStream(); 
                } else {
                    console.error("Google API Error:", err);
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
                         // Lấy speaker tag của từ cuối cùng
                        for (let i = words.length - 1; i >= 0; i--) {
                            if (words[i].speakerTag) {
                                speaker = words[i].speakerTag;
                                break;
                            }
                        }
                    }
                    socket.emit("transcript-data", { text: transcript, isFinal, speaker });
                }
            });

        // [QUAN TRỌNG] Nếu đã có Header (từ lần start đầu tiên), phải bơm lại vào stream mới ngay!
        if (webmHeader) {
            // console.log("Injecting WebM Header into new stream...");
            recognizeStream.write(webmHeader);
        }

        // 3. Hẹn giờ restart (290s)
        restartTimeout = setTimeout(() => {
            console.log("⏰ Đã đến giới hạn an toàn (290s). Server đang tự đổi Stream...");
            startStream(); 
        }, 290000); 
    };

    socket.on("start-google-stream", () => {
        console.log("🎙️ Client bắt đầu ghi âm.");
        
        // Reset header mỗi khi bắt đầu phiên mới hoàn toàn
        webmHeader = null;

        savedRequest = {
            config: {
                encoding: "WEBM_OPUS",
                sampleRateHertz: 48000,
                languageCode: "vi-VN",
                model: "latest_long",
                enableWordTimeOffsets: true,
            },
            interimResults: true,
        };

        startStream();
    });

    socket.on("audio-chunk", (data) => {
        // [MỚI] Lưu gói tin đầu tiên làm Header
        if (!webmHeader) {
            webmHeader = data;
            // console.log("Đã lưu WebM Header:", data.length, "bytes");
        }

        if (recognizeStream && !recognizeStream.destroyed) {
            try {
                recognizeStream.write(data);
            } catch (err) {
                // Ignore write errors during swap
            }
        }
    });

    socket.on("stop-google-stream", () => {
        if (restartTimeout) clearTimeout(restartTimeout);
        if (recognizeStream) {
            recognizeStream.end();
            recognizeStream = null;
        }
        webmHeader = null; // Xóa header khi dừng hẳn
        console.log("🛑 Client dừng ghi âm.");
    });

    // ... (Giữ nguyên phần Batch Analyze) ...
    socket.on("google-batch-analyze", async (fileBuffer) => {
         // (Code batch cũ của bạn giữ nguyên)
         // ...
         try {
            console.log(`📥 Nhận yêu cầu Batch: ${fileBuffer.length} bytes`);
            const audio = { content: fileBuffer.toString("base64") };
            const config = {
                encoding: "WEBM_OPUS",
                sampleRateHertz: 48000,
                languageCode: "vi-VN",
                model: "latest_long",
                enableSpeakerDiarization: true,
                diarizationConfig: { minSpeakerCount: 1, maxSpeakerCount: 5 },
            };
            const request = { audio: audio, config: config };
            const [operation] = await speechClient.longRunningRecognize(request);
            console.log("⏳ Đang xử lý Batch...");
            const [response] = await operation.promise();
            
            const result = response.results
                .map(res => {
                    const alt = res.alternatives[0];
                    if (!alt.words || alt.words.length === 0) return "";
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