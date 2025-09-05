require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");

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

// In-memory schedule (replace with DB later)
let schedules = [];

// Basic auth middleware for admin pages
function checkAuth(req, res, next) {
  const b64auth = (req.headers.authorization || "").split(" ")[1] || "";
  const [login, password] = Buffer.from(b64auth, "base64").toString().split(":");
  if (login === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Admin Area"');
  res.status(401).send("Authentication required.");
}

// Admin upload page
app.get("/upload-page", checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/upload.html"));
});

// Generate pre-signed URL for direct upload
app.post("/generate-upload-url", checkAuth, async (req, res) => {
  try {
    const { fileName, fileType, title, startTime, duration } = req.body;
    if (!fileName || !fileType || !title || !startTime) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Check and adjust startTime to avoid overlaps
    let startDate = new Date(startTime);
    const dur = parseInt(duration) || 3600; // seconds

    schedules.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    for (let video of schedules) {
      const existingStart = new Date(video.startTime);
      const existingEnd = new Date(existingStart.getTime() + video.duration * 1000);
      const newEnd = new Date(startDate.getTime() + dur * 1000);

      if (startDate < existingEnd && newEnd > existingStart) {
        startDate = new Date(existingEnd.getTime());
      }
    }

    const uniqueKey = `${Date.now()}-${uuidv4()}-${fileName}`;

    // Generate pre-signed URL
    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: uniqueKey,
      ContentType: fileType,
    };

    // Import from AWS SDK v3 for presigning
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    const command = new PutObjectCommand(params);
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour valid

    // Add to schedule (URL will be the S3 public URL after upload)
    const videoData = {
      id: Date.now(),
      title,
      url: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${uniqueKey}`,
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

// Currently live video
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

// Redirect video requests to S3 URL
app.get("/video/:id", (req, res) => {
  const video = schedules.find(v => v.id == req.params.id);
  if (!video) return res.status(404).send("Video not found");
  res.redirect(video.url);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
