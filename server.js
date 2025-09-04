require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");

// AWS SDK v3
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

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

// Multer memory storage
const upload = multer({ storage: multer.memoryStorage() });

// In-memory schedule
let schedules = [];

// Basic auth middleware
function checkAuth(req, res, next) {
  const b64auth = (req.headers.authorization || "").split(" ")[1] || "";
  const [login, password] = Buffer.from(b64auth, "base64").toString().split(":");
  if (login === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Admin Area"');
  res.status(401).send("Authentication required.");
}

// Upload page
app.get("/upload-page", checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/upload.html"));
});

// Upload endpoint with conflict checking and duration handling
app.post("/upload", checkAuth, upload.single("video"), async (req, res) => {
  try {
    let { title, startTime, duration } = req.body;
    duration = parseInt(duration) || 3600; // default 1 hour
    let startDate = new Date(startTime);

    // Sort schedule by startTime
    schedules.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    // Adjust startTime to avoid overlaps
    for (let video of schedules) {
      const existingStart = new Date(video.startTime);
      const existingEnd = new Date(existingStart.getTime() + video.duration * 1000);
      const newEnd = new Date(startDate.getTime() + duration * 1000);

      if (startDate < existingEnd && newEnd > existingStart) {
        // Shift new video to end of overlapping video
        startDate = new Date(existingEnd.getTime());
      }
    }

    const fileName = Date.now() + "-" + req.file.originalname;

    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    await s3.send(new PutObjectCommand(params));

    // Public URL (assuming bucket policy allows public read)
    const videoUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

    const videoData = {
      id: Date.now(),
      title,
      url: videoUrl,
      startTime: startDate,
      duration,
    };

    schedules.push(videoData);

    res.json({ message: "Video uploaded and scheduled!", video: videoData });
  } catch (err) {
    console.error(err);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
