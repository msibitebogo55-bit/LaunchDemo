require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

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

// Upload handler (simplified for clarity)
app.post("/upload-url", checkAuth, async (req, res) => {
  try {
    const { fileName, contentType, title, startTime, duration } = req.body;
    if (!fileName || !contentType || !startTime) {
      return res.status(400).json({ message: "Missing parameters" });
    }

    const dur = parseInt(duration) || 3600;
    let startDate = new Date(startTime);

    const key = Date.now() + "-" + fileName;
    const videoData = {
      id: Date.now(),
      title: title || fileName,
      url: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
      startTime: startDate,
      duration: dur,
    };
    schedules.push(videoData);

    res.json({ video: videoData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to generate upload URL" });
  }
});

// Current live video metadata
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

// NEW: Current video streaming
app.get("/video/current", async (req, res) => {
  const now = new Date();
  const current = schedules.find(v => {
    const start = new Date(v.startTime);
    const end = new Date(start.getTime() + v.duration * 1000);
    return now >= start && now <= end;
  });

  if (!current) {
    return res.status(404).send("No live video right now.");
  }

  try {
    // Proxy the S3 file so it streams properly
    const range = req.headers.range;
    const s3Url = current.url;

    const s3Res = await fetch(s3Url, { headers: range ? { Range: range } : {} });

    res.writeHead(s3Res.status, Object.fromEntries(s3Res.headers));
    s3Res.body.pipe(res);
  } catch (err) {
    console.error("Error streaming video:", err);
    res.status(500).send("Error streaming video");
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
