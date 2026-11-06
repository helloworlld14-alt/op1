
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const jobs = new Map();

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(v => v.trim())
    : true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

function getKey(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Missing environment variable: ${name}`);
    error.status = 503;
    throw error;
  }
  return value;
}

async function readApiResponse(response) {
  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      data.error?.message ||
      data.message ||
      `Provider error: HTTP ${response.status}`
    );
    error.status = response.status >= 400 && response.status < 500
      ? response.status
      : 502;
    error.details = data;
    throw error;
  }

  return data;
}

function sendError(res, error) {
  console.error("[EagleAI API]", error);
  res.status(error.status || 500).json({
    error: error.message || "Internal server error",
    details: error.details || undefined
  });
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      ["user", "assistant", "system"].includes(item.role) &&
      typeof item.content === "string"
    )
    .slice(-24)
    .map(item => ({
      role: item.role,
      content: item.content.slice(0, 12000)
    }));
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/", (_req, res) => {
  res.json({
    name: "EagleAI API",
    status: "running",
    features: ["Groq Chat", "Gemini Image", "Runway Video", "Tripo 3D"]
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ==========================================
// 1. CHAT AI — GROQ
// ==========================================

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const history = cleanHistory(req.body?.history);

    const messages = [
      {
        role: "system",
        content: "You are EagleAI, a helpful, accurate and friendly AI assistant. Answer clearly."
      },
      ...history
    ];

    // Avoid adding the latest user message twice
    if (
      history.at(-1)?.role !== "user" ||
      history.at(-1)?.content !== message
    ) {
      messages.push({ role: "user", content: message });
    }

    const data = await readApiResponse(await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getKey("GROQ_API_KEY")}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          messages,
          temperature: 0.7,
          max_tokens: 2048
        })
      }
    ));

    const reply = data.choices?.[0]?.message?.content || "";

    res.json({
      reply,
      message: reply,
      model: data.model
    });

  } catch (error) {
    sendError(res, error);
  }
});

// ==========================================
// 2. IMAGE AI — GOOGLE GEMINI
// ==========================================

app.post(
  ["/api/generate/image", "/api/image"],
  async (req, res) => {
    try {
      const prompt = String(
        req.body?.prompt || req.body?.message || ""
      ).trim();

      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      const model = process.env.GEMINI_IMAGE_MODEL ||
        "gemini-2.5-flash-image";

      const data = await readApiResponse(await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": getKey("GEMINI_API_KEY")
          },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [{ text: prompt }]
            }],
            generationConfig: {
              responseModalities: ["IMAGE"]
            }
          })
        }
      ));

      const parts = data.candidates?.[0]?.content?.parts || [];

      const imagePart = parts.find(part =>
        part.inlineData?.data || part.inline_data?.data
      );

      const inline = imagePart?.inlineData || imagePart?.inline_data;

      if (!inline?.data) {
        throw new Error(
          "Gemini did not return an image. Try another prompt or check model access."
        );
      }

      const mime = inline.mimeType || inline.mime_type || "image/png";
      const imageUrl = `data:${mime};base64,${inline.data}`;

      res.json({
        status: "completed",
        url: imageUrl,
        imageUrl,
        message: "Image generated successfully"
      });

    } catch (error) {
      sendError(res, error);
    }
  }
);

// ==========================================
// 3. VIDEO AI — RUNWAY
// ==========================================

app.post("/api/generate/video", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const data = await readApiResponse(await fetch(
      "https://api.dev.runwayml.com/v1/text_to_video",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getKey("RUNWAY_API_KEY")}`,
          "X-Runway-Version": "2024-11-06",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.RUNWAY_VIDEO_MODEL || "gen4.5",
          promptText: prompt.slice(0, 1000),
          ratio: process.env.RUNWAY_VIDEO_RATIO || "1280:720",
          duration: Number(process.env.RUNWAY_VIDEO_DURATION || 5)
        })
      }
    ));

    const jobId = data.id || data.taskId;

    if (!jobId) {
      throw new Error("Runway did not return a task ID");
    }

    jobs.set(jobId, { provider: "runway" });

    res.status(202).json({
      status: "processing",
      jobId,
      message: "Video generation started"
    });

  } catch (error) {
    sendError(res, error);
  }
});

// ==========================================
// 4. 3D AI — TRIPO
// Text prompt OR uploaded image
// ==========================================

app.post(
  "/api/generate/3d",
  upload.single("image"),
  async (req, res) => {
    try {
      const apiKey = getKey("TRIPO_API_KEY");
      const baseUrl = "https://openapi.tripo3d.ai/v3";

      let endpoint;
      let payload;
      let taskType;

      if (req.file) {
        // Upload image to Tripo first
        const form = new FormData();

        form.append(
          "file",
          new Blob([req.file.buffer], {
            type: req.file.mimetype || "image/png"
          }),
          req.file.originalname || "reference.png"
        );

        const uploaded = await readApiResponse(await fetch(
          `${baseUrl}/files`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`
            },
            body: form
          }
        ));

        if (uploaded.code !== 0) {
          throw new Error(uploaded.message || "Tripo image upload failed");
        }

        const fileToken = uploaded.data?.file_token;

        if (!fileToken) {
          throw new Error("Tripo did not return an image file token");
        }

        endpoint = `${baseUrl}/generation/image-to-model`;
        taskType = "image_to_model";

        payload = {
          type: "image_to_model",
          input: fileToken,
          model: process.env.TRIPO_MODEL || "v3.1-20260211",
          texture: true,
          pbr: true
        };

      } else {
        const prompt = String(req.body?.prompt || "").trim();

        if (!prompt) {
          return res.status(400).json({
            error: "Enter a prompt or upload an image"
          });
        }

        endpoint = `${baseUrl}/generation/text-to-model`;
        taskType = "text_to_model";

        payload = {
          prompt: prompt.slice(0, 1024),
          model: process.env.TRIPO_MODEL || "v3.1-20260211",
          texture: true,
          pbr: true
        };
      }

      const result = await readApiResponse(await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }));

      if (result.code !== 0) {
        throw new Error(result.message || "Tripo generation failed");
      }

      const jobId = result.data?.task_id;

      if (!jobId) {
        throw new Error("Tripo did not return a task ID");
      }

      jobs.set(jobId, {
        provider: "tripo",
        taskType
      });

      res.status(202).json({
        status: "processing",
        jobId,
        message: "3D model generation started"
      });

    } catch (error) {
      sendError(res, error);
    }
  }
);

// ==========================================
// VIDEO + 3D GENERATION STATUS
// ==========================================

app.get("/api/generate/status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        error: "Job not found. Start a new generation."
      });
    }

    // --------------------------------------
    // RUNWAY VIDEO STATUS
    // --------------------------------------

    if (job.provider === "runway") {
      const data = await readApiResponse(await fetch(
        `https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(jobId)}`,
        {
          headers: {
            Authorization: `Bearer ${getKey("RUNWAY_API_KEY")}`,
            "X-Runway-Version": "2024-11-06"
          }
        }
      ));

      const state = String(data.status || "").toUpperCase();
      const output = Array.isArray(data.output)
        ? data.output[0]
        : data.output;

      if (["SUCCEEDED", "COMPLETED"].includes(state)) {
        jobs.delete(jobId);

        return res.json({
          status: "completed",
          url: output,
          videoUrl: output
        });
      }

      if (["FAILED", "CANCELED", "CANCELLED"].includes(state)) {
        jobs.delete(jobId);

        return res.json({
          status: "failed",
          error: data.failure || data.error || "Video generation failed"
        });
      }

      return res.json({
        status: "processing",
        progress: data.progress || 0
      });
    }

    // --------------------------------------
    // TRIPO 3D STATUS
    // --------------------------------------

    if (job.provider === "tripo") {
      const data = await readApiResponse(await fetch(
        `https://openapi.tripo3d.ai/v3/tasks/${encodeURIComponent(jobId)}`,
        {
          headers: {
            Authorization: `Bearer ${getKey("TRIPO_API_KEY")}`
          }
        }
      ));

      if (data.code !== 0) {
        throw new Error(data.message || "Tripo status request failed");
      }

      const task = data.data || {};
      const state = String(task.status || "").toLowerCase();

      if (state === "success") {
        jobs.delete(jobId);

        return res.json({
          status: "completed",
          modelUrl: task.output?.model_url,
          url: task.output?.model_url,
          previewUrl: task.output?.rendered_image_url
        });
      }

      if (["failed", "cancelled"].includes(state)) {
        jobs.delete(jobId);

        return res.json({
          status: "failed",
          error: task.message || `Tripo task ${state}`
        });
      }

      return res.json({
        status: "processing",
        progress: task.progress || 0
      });
    }

    return res.status(400).json({
      error: "Unsupported generation provider"
    });

  } catch (error) {
    sendError(res, error);
  }
});

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================

app.use((error, _req, res, _next) => {
  sendError(res, error);
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
  console.log(`EagleAI API running on port ${PORT}`);
  console.log("Chat: Groq");
  console.log("Image: Gemini");
  console.log("Video: Runway");
  console.log("3D: Tripo AI");
});
