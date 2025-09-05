require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// AWS S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Multer disk storage (temporary storage, not RAM)
const upload = multer({ dest: "uploads/" });

// Schedule storage (in memory, restored from S3 on startup)
let schedules = [];
const SCHEDULE_FILE = "schedule.json";

// --- Helpers ---
async function loadScheduleFromS3() {
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: SCHEDULE_FILE,
    });
    const response = await s3.send(command);

    const body = await streamToString(response.Body);
    schedules = JSON.parse(body);
    console.log("✅ Schedule loaded from S3");
  } catch (err) {
    console.log("⚠️ No schedule file found on S3, starting fresh");
    schedules = [];
  }
}

async function saveScheduleToS3() {
  try {
    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: SCHEDULE_FILE,
      Body: JSON.stringify(schedules, null, 2),
      ContentType: "application/json",
    };
    await s3.send(new PutObjectCommand(params));
    console.log("✅ Schedule saved to S3");
  } catch (err) {
    console.error("❌ Failed to save schedule:", err);
  }
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

// --- Auth middleware ---
function checkAuth(req, res, next) {
  const b64auth = (req.headers.authorization || "").split(" ")[1] || "";
  const [login, password] = Buffer.from(b64auth, "base64").toString().split(":");
  if (login === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Admin Area"');
  res.status(401).send("Authentication required.");
}

// --- Routes ---
// Upload page
app.get("/upload-page", checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/upload.html"));
});

// Upload endpoint
app.post("/upload", checkAuth, upload.single("video"), async (req, res) => {
  try {
    let { title, startTime, duration } = req.body;
    duration = parseInt(duration) || 3600; // default 1 hour
    let startDate = new Date(startTime);

    // Avoid overlap by shifting if needed
    schedules.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    for (let video of schedules) {
      const existingStart = new Date(video.startTime);
      const existingEnd = new Date(existingStart.getTime() + video.duration * 1000);
      const newEnd = new Date(startDate.getTime() + duration * 1000);

      if (startDate < existingEnd && newEnd > existingStart) {
        startDate = new Date(existingEnd.getTime());
      }
    }

    const fileName = Date.now() + "-" + req.file.originalname;

    // Upload file stream directly to S3
    const fileStream = fs.createReadStream(req.file.path);
    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: fileName,
      Body: fileStream,
      ContentType: req.file.mimetype,
    };

    await s3.send(new PutObjectCommand(params));
    fs.unlinkSync(req.file.path); // delete temp file

    const videoUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

    const videoData = {
      id: Date.now(),
      title,
      url: videoUrl,
      startTime: startDate,
      duration,
    };

    schedules.push(videoData);
    await saveScheduleToS3();

    res.json({ message: "Video uploaded and scheduled!", video: videoData });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Upload failed");
  }
});

// Get currently live video
app.get("/now", (req, res) => {
  const now = new Date();
  const current = schedules.find((v) => {
    const start = new Date(v.startTime);
    const end = new Date(start.getTime() + v.duration * 1000);
    return now >= start && now <= end;
  });
  res.json(current || {});
});

// Full schedule
app.get("/schedule", (req, res) => {
  res.json(schedules.sort((a, b) => new Date(a.startTime) - new Date(b.startTime)));
});

// Redirect video requests to S3 URL
app.get("/video/:id", (req, res) => {
  const video = schedules.find((v) => v.id == req.params.id);
  if (!video) return res.status(404).send("Video not found");
  res.redirect(video.url);
});

// --- Startup ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await loadScheduleFromS3();
});
