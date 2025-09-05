require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
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

// Generate S3 pre-signed URL for uploading
app.post("/upload-url", checkAuth, async (req, res) => {
  try {
    const { fileName, contentType, title, startTime, duration } = req.body;
    if (!fileName || !contentType || !startTime) return res.status(400).json({ message: "Missing parameters" });

    const dur = parseInt(duration) || 3600; // default 1 hour
    let startDate = new Date(startTime);

    // Sort schedule and avoid overlaps
    schedules.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    for (let video of schedules) {
      const existingStart = new Date(video.startTime);
      const existingEnd = new Date(existingStart.getTime() + video.duration * 1000);
      const newEnd = new Date(startDate.getTime() + dur * 1000);
      if (startDate < existingEnd && newEnd > existingStart) {
        startDate = new Date(existingEnd.getTime()); // shift to end of last overlapping video
      }
    }

    const key = Date.now() + "-" + fileName;
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    // Add video to schedule
    const videoData = {
      id: Date.now(),
      title: title || fileName,
      url: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
      startTime: startDate,
      duration: dur,
    };
    schedules.push(videoData);

    res.json({ uploadUrl, video: videoData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to generate upload URL" });
  }
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

// Stream video directly from S3
app.get("/video/:id", async (req, res) => {
  try {
    const video = schedules.find(v => v.id == req.params.id);
    if (!video) return res.status(404).send("Video not found");

    const urlParts = new URL(video.url);
    const key = urlParts.pathname.slice(1); // remove leading "/"

    const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key });
    const s3Response = await s3.send(command);

    res.setHeader("Content-Type", s3Response.ContentType || "video/mp4");
    if (s3Response.ContentLength) {
      res.setHeader("Content-Length", s3Response.ContentLength);
    }

    s3Response.Body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to stream video");
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
