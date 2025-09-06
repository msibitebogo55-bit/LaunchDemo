require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

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

// Add video to schedule (already uploaded to S3)
app.post("/schedule-video", checkAuth, (req, res) => {
  const { title, url, startTime, duration } = req.body;
  if (!title || !url || !startTime || !duration) return res.status(400).json({ message: "Missing fields" });

  let startDate = new Date(startTime);
  const dur = parseInt(duration);

  // Avoid overlap
  schedules.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  for (let video of schedules) {
    const existingStart = new Date(video.startTime);
    const existingEnd = new Date(existingStart.getTime() + video.duration * 1000);
    const newEnd = new Date(startDate.getTime() + dur * 1000);
    if (startDate < existingEnd && newEnd > existingStart) {
      startDate = new Date(existingEnd.getTime());
    }
  }

  const videoData = {
    id: Date.now(),
    title,
    url,
    startTime: startDate,
    duration: dur,
  };
  schedules.push(videoData);

  res.json({ message: "Scheduled!", video: videoData });
});

// Get currently live video
app.get("/now", (req, res) => {
  const now = new Date();
  const current = schedules.find(v => {
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

// Stream video directly from S3 to user
app.get("/video/:id", async (req, res) => {
  const video = schedules.find(v => v.id == req.params.id);
  if (!video) return res.status(404).send("Video not found");

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: video.url.split("/").pop(),
    });
    const s3Stream = (await s3.send(command)).Body;

    res.setHeader("Content-Type", "video/mp4");
    s3Stream.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to stream video");
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
