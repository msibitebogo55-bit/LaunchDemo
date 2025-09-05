require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
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

    // Parse duration and start time
    const dur = parseInt(duration) || 3600; // default 1 hour
    let startDate = new Date(startTime);

    // Sort schedule and prevent overlaps
    schedules.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    for (let video of schedules) {
      const existingStart = new Date(video.startTime);
      const existingEnd = new Date(existingStart.getTime() + video.duration * 1000);
      const newEnd = new Date(startDate.getTime() + dur * 1000);
      if (startDate < existingEnd && newEnd > existingStart) {
        startDate = new Date(existingEnd.getTime());
      }
    }

    // S3 key (file path)
    const key = Date.now() + "-" + fileName;

    // Generate pre-signed URL
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      // No ACL because bucket has owner enforced
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    // Add to schedule
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

// Redirect video requests to S3 URL
app.get("/video/:id", (req, res) => {
  const video = schedules.find(v => v.id == req.params.id);
  if (!video) return res.status(404).send("Video not found");
  res.redirect(video.url);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
