/**
 * Head Pose Data Collector — Web App (Pure Frontend)
 * ====================================================
 * Teknologi : MediaPipe FaceLandmarker (tasks-vision) + JSZip
 * Platform  : Browser modern (Chrome/Firefox/Safari) — HP & Laptop
 * Backend   : TIDAK ADA — semua berjalan di browser
 *
 * Alur:
 *  1. User mengisi form registrasi → tekan "Mulai Sesi Foto"
 *  2. MediaPipe dimuat dari CDN (hanya 1x, lalu di-cache browser)
 *  3. Kamera aktif → deteksi sudut kepala real-time
 *  4. Saat sudut pas dan stabil → foto otomatis diambil + disimpan di memori
 *  5. Saat selesai → semua foto dikemas jadi 1 file .zip → download ke HP/laptop
 */

import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ─────────────────────────────────────────────────────────────
// PRESET SUDUT POSE
// ─────────────────────────────────────────────────────────────
const PRESETS = {
  standard: { name: "Multi-PIE Standard (9 Poses)", angles: [-60, -45, -30, -15, 0, 15, 30, 45, 60] },
  full:     { name: "Multi-PIE Full (13 Poses)",    angles: [-90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90] },
  quick:    { name: "Ringkas (5 Poses)",             angles: [-45, -20, 0, 20, 45] },
};

const CAPTURE_COOLDOWN_MS = 1500; // Cooldown 1.5 detik setelah foto untuk cegah jepret ganda

// ─────────────────────────────────────────────────────────────
// STATE GLOBAL
// ─────────────────────────────────────────────────────────────
let config            = null;   // Konfigurasi sesi dari form registrasi
let faceLandmarker    = null;   // Instance MediaPipe FaceLandmarker
let videoStream       = null;   // MediaStream dari kamera
let currentFacingMode = "user"; // "user" (kamera depan) atau "environment" (kamera belakang)
let rafId             = null;   // ID requestAnimationFrame loop
let lastDetectMs      = 0;      // Timestamp deteksi terakhir (throttle 30fps)
let lastCaptureMs     = 0;      // Timestamp capture terakhir
let lastPose          = { ok: false, yaw: 0, pitch: 0, roll: 0 };

let poseStatus          = {};         // { angle: { captured, filename, timestamp, measuredYaw, ... } }
let currentTargetIndex  = 0;
let holdStartMs         = null;       // Waktu mulai tahan pose stabil
let flashTid            = null;       // Timeout ID animasi flash

const capturedPhotos    = new Map();  // angle → { blob, filename } — disimpan di memori sampai ZIP

// Canvas tersembunyi untuk menangkap frame bersih dari video
const capCanvas = document.createElement("canvas");
const capCtx    = capCanvas.getContext("2d");
const guideCanvas = document.createElement("canvas");
const guideCtx    = guideCanvas.getContext("2d");

// ─────────────────────────────────────────────────────────────
// REFERENSI DOM
// ─────────────────────────────────────────────────────────────
const screenRegister  = document.getElementById("screen-register");
const screenCamera    = document.getElementById("screen-camera");
const loadingBox      = document.getElementById("loading-box");
const registerForm    = document.getElementById("register-form");
const btnStart        = document.getElementById("btn-start");

const video           = document.getElementById("video");
const flashOverlay    = document.getElementById("flash-overlay");

const topName         = document.getElementById("top-name");
const topId           = document.getElementById("top-id");
const topCount        = document.getElementById("top-count");
const btnSwitchCam    = document.getElementById("btn-switch-cam");
const camModeLbl      = document.getElementById("cam-mode-lbl");

const targetCard      = document.getElementById("target-card");
const targetLbl       = document.getElementById("target-lbl");
const instrLbl        = document.getElementById("instr-lbl");
const holdFill        = document.getElementById("hold-fill");

const valYaw          = document.getElementById("val-yaw");
const valPitch        = document.getElementById("val-pitch");
const valRoll         = document.getElementById("val-roll");

const clList          = document.getElementById("cl-list");
const completeBanner  = document.getElementById("complete-banner");

const centerGuide     = document.getElementById("center-guide");
const guideStatus     = document.getElementById("guide-status");

// ─────────────────────────────────────────────────────────────
// UTILITAS UMUM
// ─────────────────────────────────────────────────────────────

function sanitizeName(raw) {
  return raw.replace(/[^a-zA-Z0-9 _\-]/g, "").trim().replace(/ +/g, "_") || "Subject";
}

function generateUID(name) {
  const clean = sanitizeName(name);
  const ts    = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand  = Math.random().toString(36).slice(2, 8);
  return `${clean}_${ts}_${rand}`;
}

/**
 * Ekstrak sudut Euler (Pitch, Yaw, Roll) dalam derajat dari matriks transformasi 4×4.
 * Matriks disimpan row-major (Float32Array 16 elemen).
 * Konvensi rotasi: XYZ — cocok dengan scipy Rotation.as_euler('xyz') di Python.
 */
function matToEuler(m) {
  const R = (r, c) => m[r * 4 + c];
  const sy = Math.hypot(R(0, 0), R(1, 0));
  const D  = 180 / Math.PI;
  if (sy > 1e-6) {
    return {
      pitch: Math.atan2(R(2, 1), R(2, 2)) * D,
      yaw:   Math.atan2(-R(2, 0), sy)     * D,
      roll:  Math.atan2(R(1, 0), R(0, 0)) * D,
    };
  } else {
    return {
      pitch: Math.atan2(-R(1, 2), R(1, 1)) * D,
      yaw:   Math.atan2(-R(2, 0), sy)      * D,
      roll:  0,
    };
  }
}

/**
 * Menyalin area yang tepat berada di dalam kotak panduan ke canvas.
 * Canvas inilah yang menjadi input pose estimator, bukan seluruh frame kamera.
 */
function getGuideCrop() {
  if (!video.videoWidth || !video.videoHeight || !centerGuide) return null;

  const videoRect = video.getBoundingClientRect();
  const guideRect = centerGuide.getBoundingClientRect();
  if (!videoRect.width || !videoRect.height || !guideRect.width || !guideRect.height) return null;

  // object-fit: cover: hitung pemetaan area tampilan ke piksel video asli.
  const scale = Math.max(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
  const renderedW = video.videoWidth * scale;
  const renderedH = video.videoHeight * scale;
  const padX = (videoRect.width - renderedW) / 2;
  const padY = (videoRect.height - renderedH) / 2;

  let sx = (guideRect.left - videoRect.left - padX) / scale;
  let sy = (guideRect.top - videoRect.top - padY) / scale;
  let sw = guideRect.width / scale;
  let sh = guideRect.height / scale;
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  sw = Math.min(sw, video.videoWidth - sx);
  sh = Math.min(sh, video.videoHeight - sy);
  if (sw < 20 || sh < 20) return null;

  guideCanvas.width = Math.round(sw);
  guideCanvas.height = Math.round(sh);
  guideCtx.drawImage(video, sx, sy, sw, sh, 0, 0, guideCanvas.width, guideCanvas.height);
  return guideCanvas;
}

function applyGuideSettings() {
  if (!config || !centerGuide) return;
  centerGuide.style.setProperty("--guide-width", `${config.guideWidthPct}%`);
  centerGuide.style.setProperty("--guide-height", `${config.guideHeightPct}%`);
  centerGuide.style.setProperty("--guide-offset-y", `${config.guideOffsetY}px`);
}

/** Bunyi beep singkat menggunakan Web Audio API. */
function beep(freq = 1300, dur = 0.12) {
  try {
    const ctx  = new AudioContext();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur);
  } catch (_) {}
}

/** Animasi flash putih sesaat saat foto diambil. */
function triggerFlash() {
  flashOverlay.classList.remove("flashing");
  void flashOverlay.offsetWidth; // reflow paksa untuk restart animasi
  flashOverlay.classList.add("flashing");
  clearTimeout(flashTid);
  flashTid = setTimeout(() => flashOverlay.classList.remove("flashing"), 400);
}

// ─────────────────────────────────────────────────────────────
// INISIALISASI MEDIAPIPE
// ─────────────────────────────────────────────────────────────

async function initMediaPipe() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "./face_landmarker.task",  // Model ada di folder yang sama
      delegate: "GPU",
    },
    outputFacialTransformationMatrixes: true,
    numFaces: 1,
    runningMode: "VIDEO",
    minFaceDetectionConfidence: 0.2,
    minFacePresenceConfidence: 0.2,
    minTrackingConfidence: 0.2,
  });
}

// ─────────────────────────────────────────────────────────────
// INISIALISASI KAMERA
// ─────────────────────────────────────────────────────────────

async function startCamera(facing = currentFacingMode) {
  currentFacingMode = facing;

  // Hentikan stream lama jika sedang berjalan
  if (videoStream) {
    videoStream.getTracks().forEach((track) => track.stop());
    videoStream = null;
  }

  const isFront = currentFacingMode === "user";

  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: currentFacingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (_) {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  }

  video.srcObject = videoStream;

  // Terapkan class rear-cam (tanpa mirror) jika kamera belakang
  video.classList.toggle("rear-cam", !isFront);
  if (camModeLbl) {
    camModeLbl.textContent = isFront ? "Kamera Depan" : "Kamera Belakang";
  }

  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      capCanvas.width  = video.videoWidth;
      capCanvas.height = video.videoHeight;
      resolve();
    };
  });
}

// ─────────────────────────────────────────────────────────────
// TANGKAP FOTO
// ─────────────────────────────────────────────────────────────

function capturePhoto(targetAngle, yaw, pitch, roll) {
  const isFront = currentFacingMode === "user";
  capCtx.save();
  if (isFront) {
    // Kamera depan di-mirror agar sesuai tampilan preview selfie
    capCtx.translate(capCanvas.width, 0);
    capCtx.scale(-1, 1);
  }
  capCtx.drawImage(video, 0, 0, capCanvas.width, capCanvas.height);
  capCtx.restore();

  capCanvas.toBlob((blob) => {
    if (!blob) return;

    const sign     = targetAngle >= 0 ? "+" : "";
    const filename = `yaw_${sign}${targetAngle}.jpg`;
    const now      = new Date().toLocaleString("id-ID");

    // Simpan blob di memori
    capturedPhotos.set(targetAngle, { blob, filename });

    // Update metadata pose
    poseStatus[targetAngle] = {
      captured: true, filename, timestamp: now,
      measuredYaw:   +yaw.toFixed(2),
      measuredPitch: +pitch.toFixed(2),
      measuredRoll:  +roll.toFixed(2),
    };

    // Feedback
    triggerFlash();
    beep();
    updateChecklist();
    updateProgress();

    // Maju ke pose berikutnya yang belum diambil
    advanceTarget();

    // Cek apakah semua sudah selesai
    if (config.angles.every((a) => poseStatus[a]?.captured)) {
      completeBanner.classList.remove("hidden");
    }
  }, "image/jpeg", 0.92);
}

// ─────────────────────────────────────────────────────────────
// NAVIGASI POSE
// ─────────────────────────────────────────────────────────────

function advanceTarget() {
  const n = config.angles.length;
  for (let s = 1; s <= n; s++) {
    const idx = (currentTargetIndex + s) % n;
    if (!poseStatus[config.angles[idx]]?.captured) {
      currentTargetIndex = idx;
      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// DETECTION LOOP (requestAnimationFrame)
// ─────────────────────────────────────────────────────────────

function detectLoop() {
  if (!video.readyState || video.readyState < 2) {
    rafId = requestAnimationFrame(detectLoop);
    return;
  }

  const now = performance.now();

  let { ok: poseOk, yaw, pitch, roll } = lastPose;

  // Throttle deteksi ke ~30fps untuk hemat CPU
  if (now - lastDetectMs > 33) {
    lastDetectMs = now;
    try {
      const guideCrop = getGuideCrop();
      if (!guideCrop) throw new Error("Kotak panduan belum siap");
      const res = faceLandmarker.detectForVideo(guideCrop, now);
      const mats = res.facialTransformationMatrixes;
      if (mats?.length > 0) {
        poseOk = true;
        const e = matToEuler(mats[0].data);
        pitch = e.pitch; yaw = e.yaw; roll = e.roll;
        lastPose = { ok: true, yaw, pitch, roll };
      } else {
        poseOk = false;
        lastPose = { ok: false, yaw: 0, pitch: 0, roll: 0 };
      }
    } catch (_) {
      poseOk = false;
      lastPose = { ok: false, yaw: 0, pitch: 0, roll: 0 };
    }
  }

  const targetAngle = config.angles[currentTargetIndex];
  const alreadyDone = poseStatus[targetAngle]?.captured;
  const yawDiff     = yaw - targetAngle;

  const yawOk     = Math.abs(yawDiff) <= config.tolerance;
  const pitchOk   = Math.abs(pitch)   <= config.pitchTolerance;
  const rollOk    = Math.abs(roll)    <= config.rollTolerance;
  const matched   = poseOk && yawOk && pitchOk && rollOk && !alreadyDone;

  const cooldownActive = (now - lastCaptureMs) < CAPTURE_COOLDOWN_MS;
  let progress = 0;

  if (matched && !cooldownActive) {
    lastCaptureMs = now;
    holdStartMs = null;
    capturePhoto(targetAngle, yaw, pitch, roll);
    rafId = requestAnimationFrame(detectLoop);
    return;
  } else if (matched && cooldownActive) {
    const elapsedCd = (now - lastCaptureMs);
    progress = Math.min(1, elapsedCd / CAPTURE_COOLDOWN_MS);
  } else {
    holdStartMs = null;
    progress = 0;
  }

  renderHUD(poseOk, yaw, pitch, roll, targetAngle, matched, alreadyDone, progress, yawDiff);
  rafId = requestAnimationFrame(detectLoop);
}

// ─────────────────────────────────────────────────────────────
// RENDER HUD
// ─────────────────────────────────────────────────────────────

function renderHUD(poseOk, yaw, pitch, roll, targetAngle, matched, done, progress, yawDiff) {
  // Update status kotak panduan tengah (viewfinder)
  if (centerGuide && guideStatus) {
    if (!poseOk) {
      centerGuide.className = "";
      guideStatus.textContent = "Jaga seluruh kepala di dalam kotak";
    } else if (matched) {
      centerGuide.className = "guide-centered";
      guideStatus.textContent = "Pose sesuai — kepala tetap di dalam kotak";
    } else {
      centerGuide.className = "";
      guideStatus.textContent = "Area kotak sedang diproses";
    }
  }

  // Target label
  const sign = targetAngle >= 0 ? "+" : "";
  const dir  = targetAngle === 0 ? "(FRONTAL)" : targetAngle < 0 ? "(TENGOK KIRI)" : "(TENGOK KANAN)";
  targetLbl.textContent = `TARGET: ${sign}${targetAngle}° ${dir}`;

  // Target card color
  targetCard.classList.toggle("matched", matched);

  // Instruksi
  let instr = "", instrColor = "var(--muted)";

  if (done) {
    instr = "✓ Sudah diambil. Pilih pose lain atau [↺] foto ulang.";
    instrColor = "var(--muted)";
  } else if (!poseOk) {
    instr = "Pastikan kepala terlihat penuh di dalam kotak panduan";
  } else if (matched) {
    instr = "🟢 PAS! Foto diambil...";
    instrColor = "var(--green)";
  } else {
    if (Math.abs(yawDiff) > config.tolerance) {
      instr = yawDiff < 0
        ? `Tengok ke KANAN (+${Math.abs(yawDiff).toFixed(0)}°)`
        : `Tengok ke KIRI (${Math.abs(yawDiff).toFixed(0)}°)`;
    } else if (Math.abs(pitch) > config.pitchTolerance) {
      instr = "Tegakkan kepala — jangan mendongak / menunduk";
    } else if (Math.abs(roll) > config.rollTolerance) {
      instr = "Luruskan kepala — jangan miring";
    } else {
      instr = "Arahkan ke sudut target";
    }
    instrColor = "var(--yellow)";
  }
  instrLbl.textContent  = instr;
  instrLbl.style.color  = instrColor;

  // Hold bar
  holdFill.style.width = `${progress * 100}%`;

  // Sudut aktual
  if (poseOk) {
    const fmt = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}°`;
    valYaw.textContent   = fmt(yaw);
    valPitch.textContent = fmt(pitch);
    valRoll.textContent  = fmt(roll);
    valYaw.style.color   = Math.abs(yaw - config.angles[currentTargetIndex]) <= config.tolerance ? "var(--green)" : "var(--text)";
    valPitch.style.color = Math.abs(pitch) <= config.pitchTolerance ? "var(--green)" : "var(--yellow)";
    valRoll.style.color  = Math.abs(roll)  <= config.rollTolerance ? "var(--green)" : "var(--yellow)";
  } else {
    [valYaw, valPitch, valRoll].forEach((el) => { el.textContent = "—"; el.style.color = "var(--muted)"; });
  }
}

// ─────────────────────────────────────────────────────────────
// CHECKLIST & PROGRESS
// ─────────────────────────────────────────────────────────────

function buildChecklist() {
  clList.innerHTML = "";
  config.angles.forEach((ang, idx) => {
    const li   = document.createElement("li");
    const sign = ang >= 0 ? "+" : "";
    li.innerHTML = `<span class="cl-sym">○</span><span>${sign}${ang}°</span>`;
    li.addEventListener("click", () => {
      currentTargetIndex = idx;
      holdStartMs = null;
      updateChecklist();
    });
    clList.appendChild(li);
  });
}

function updateChecklist() {
  const items = clList.querySelectorAll("li");
  config.angles.forEach((ang, idx) => {
    const li   = items[idx];
    if (!li) return;
    const sym  = li.querySelector(".cl-sym");
    const done = poseStatus[ang]?.captured;
    const curr = idx === currentTargetIndex;
    li.className = done ? "cl-done" : curr ? "cl-current" : "";
    sym.textContent = done ? "✓" : curr ? "→" : "○";
  });
}

function updateProgress() {
  const total = config.angles.length;
  const done  = config.angles.filter((a) => poseStatus[a]?.captured).length;
  topCount.textContent = `${done}/${total}`;
  topCount.style.color = done === total ? "var(--green)" : "var(--text)";
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD ZIP
// ─────────────────────────────────────────────────────────────

async function downloadZip() {
  if (typeof JSZip === "undefined") {
    alert("JSZip belum siap. Coba lagi dalam beberapa detik.");
    return;
  }
  if (capturedPhotos.size === 0) {
    alert("Belum ada foto yang diambil.");
    return;
  }

  const zip    = new JSZip();
  const folder = zip.folder(config.uniqueId);

  for (const [, { blob, filename }] of capturedPhotos) {
    folder.file(filename, blob);
  }

  // Metadata sesi
  const meta = {
    subject_name:  config.name,
    subject_id:    config.uniqueId,
    preset:        PRESETS[config.presetKey].name,
    angles:        config.angles,
    tolerance_yaw: config.tolerance,
    tolerance_pitch: config.pitchTolerance,
    tolerance_roll:  config.rollTolerance,
    guide_width_pct: config.guideWidthPct,
    guide_height_pct: config.guideHeightPct,
    guide_offset_y: config.guideOffsetY,
    total_targets:   config.angles.length,
    total_captured:  capturedPhotos.size,
    photos: config.angles.map((ang) => ({
      target_yaw:    ang,
      filename:      poseStatus[ang]?.filename ?? null,
      captured:      poseStatus[ang]?.captured ?? false,
      timestamp:     poseStatus[ang]?.timestamp ?? null,
      measured_yaw:  poseStatus[ang]?.measuredYaw ?? null,
      measured_pitch:poseStatus[ang]?.measuredPitch ?? null,
      measured_roll: poseStatus[ang]?.measuredRoll ?? null,
    })),
  };
  folder.file("session_info.json", JSON.stringify(meta, null, 2));

  const blob = await zip.generateAsync({ type: "blob" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${config.uniqueId}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────
// MULAI SESI
// ─────────────────────────────────────────────────────────────

async function startSession(cfg) {
  config = cfg;
  applyGuideSettings();

  // Reset state
  poseStatus = {};
  capturedPhotos.clear();
  config.angles.forEach((a) => { poseStatus[a] = { captured: false }; });
  currentTargetIndex = 0;
  holdStartMs = null;
  lastPose = { ok: false, yaw: 0, pitch: 0, roll: 0 };
  completeBanner.classList.add("hidden");

  // Top bar
  topName.textContent = config.name;
  topId.textContent   = config.uniqueId;
  updateProgress();
  buildChecklist();
  updateChecklist();

  // Switch screen
  screenRegister.classList.remove("active");
  screenCamera.classList.add("active");

  // Kamera
  try {
    await startCamera(currentFacingMode);
  } catch (err) {
    alert("Gagal membuka kamera: " + err.message + "\n\nPastikan izin kamera sudah diberikan di browser.");
    screenCamera.classList.remove("active");
    screenRegister.classList.add("active");
    return;
  }

  // Mulai loop deteksi
  detectLoop();
}

// ─────────────────────────────────────────────────────────────
// FORM REGISTRASI — EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

document.getElementById("inp-tol").addEventListener("input", (e) => {
  document.getElementById("lbl-tol").textContent = e.target.value;
});
[
  ["inp-pitch-tol", "lbl-pitch-tol"],
  ["inp-roll-tol", "lbl-roll-tol"],
  ["inp-guide-width", "lbl-guide-width"],
  ["inp-guide-height", "lbl-guide-height"],
  ["inp-guide-offset", "lbl-guide-offset"],
].forEach(([inputId, labelId]) => {
  document.getElementById(inputId).addEventListener("input", (e) => {
    document.getElementById(labelId).textContent = e.target.value;
  });
});
registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const rawName = document.getElementById("inp-name").value.trim();
  if (!rawName) return;

  const presetKey    = document.getElementById("inp-preset").value;
  const tolerance    = parseInt(document.getElementById("inp-tol").value, 10);
  const pitchTolerance = parseInt(document.getElementById("inp-pitch-tol").value, 10);
  const rollTolerance = parseInt(document.getElementById("inp-roll-tol").value, 10);
  const guideWidthPct = parseInt(document.getElementById("inp-guide-width").value, 10);
  const guideHeightPct = parseInt(document.getElementById("inp-guide-height").value, 10);
  const guideOffsetY = parseInt(document.getElementById("inp-guide-offset").value, 10);
  const cameraChoice = document.getElementById("inp-camera")?.value || "user";
  currentFacingMode  = cameraChoice;
  const holdDuration = 0;

  btnStart.disabled = true;
  loadingBox.classList.remove("hidden");

  try {
    if (!faceLandmarker) await initMediaPipe();
  } catch (err) {
    alert("Gagal memuat MediaPipe:\n" + err.message + "\n\nPastikan koneksi internet aktif (diperlukan hanya saat pertama kali).");
    btnStart.disabled = false;
    loadingBox.classList.add("hidden");
    return;
  }

  loadingBox.classList.add("hidden");
  btnStart.disabled = false;

  await startSession({
    name:         rawName,
    uniqueId:     generateUID(rawName),
    presetKey,
    angles:       PRESETS[presetKey].angles,
    tolerance,
    pitchTolerance,
    rollTolerance,
    guideWidthPct,
    guideHeightPct,
    guideOffsetY,
    holdDuration,
  });
});

// ─────────────────────────────────────────────────────────────
// KONTROL KAMERA — EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

document.getElementById("btn-prev").addEventListener("click", () => {
  currentTargetIndex = (currentTargetIndex - 1 + config.angles.length) % config.angles.length;
  holdStartMs = null;
  updateChecklist();
});

document.getElementById("btn-next").addEventListener("click", () => {
  currentTargetIndex = (currentTargetIndex + 1) % config.angles.length;
  holdStartMs = null;
  updateChecklist();
});

document.getElementById("btn-shutter").addEventListener("click", () => {
  if (!faceLandmarker || !videoStream) return;
  const targetAngle = config.angles[currentTargetIndex];
  let yaw = 0, pitch = 0, roll = 0;
  try {
    const guideCrop = getGuideCrop();
    if (!guideCrop) throw new Error("Kotak panduan belum siap");
    const res = faceLandmarker.detectForVideo(guideCrop, performance.now());
    if (res.facialTransformationMatrixes?.length > 0) {
      const e = matToEuler(res.facialTransformationMatrixes[0].data);
      yaw = e.yaw; pitch = e.pitch; roll = e.roll;
    }
  } catch (_) {}
  capturePhoto(targetAngle, yaw, pitch, roll);
});

document.getElementById("btn-retake").addEventListener("click", () => {
  if (!config) return;
  const ang = config.angles[currentTargetIndex];
  if (poseStatus[ang]) poseStatus[ang].captured = false;
  capturedPhotos.delete(ang);
  holdStartMs = null;
  completeBanner.classList.add("hidden");
  updateChecklist();
  updateProgress();
});

document.getElementById("btn-done").addEventListener("click", downloadZip);
document.getElementById("btn-dl-zip").addEventListener("click", downloadZip);

// Tombol Switch Kamera (Depan / Belakang)
if (btnSwitchCam) {
  btnSwitchCam.addEventListener("click", async () => {
    btnSwitchCam.disabled = true;
    const nextFacing = (currentFacingMode === "user") ? "environment" : "user";
    try {
      await startCamera(nextFacing);
    } catch (err) {
      alert("Gagal beralih kamera:\n" + err.message);
    } finally {
      btnSwitchCam.disabled = false;
    }
  });
}

// Checklist toggle
document.getElementById("cl-toggle").addEventListener("click", () => {
  document.getElementById("cl-panel").classList.toggle("collapsed");
});
