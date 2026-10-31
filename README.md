# Head Pose Data Collector — Web App

Aplikasi pengumpulan data wajah berbasis sudut kepala, berjalan **100% di browser** tanpa backend, tanpa server, tanpa install apapun.

Teknologi: **MediaPipe FaceLandmarker (JS)** + **JSZip** + **HTML/CSS/JS murni**

---

## 📁 Isi Folder

```
HeadPoseCollector_Web/
├── index.html            ← Halaman utama
├── style.css             ← Tampilan dark theme
├── app.js                ← Logika deteksi & auto-capture
└── face_landmarker.task  ← Model MediaPipe (3.5 MB)
```

---

## 🚀 Cara Deploy ke GitHub Pages (Langkah per Langkah)

### Langkah 1 — Buat Akun GitHub (jika belum punya)
1. Buka [https://github.com](https://github.com)
2. Klik **Sign up** → isi email, password, username
3. Verifikasi email

---

### Langkah 2 — Buat Repository Baru
1. Login ke GitHub
2. Klik tombol **+** di pojok kanan atas → **New repository**
3. Isi:
   - **Repository name**: `head-pose-collector` (atau nama lain, bebas)
   - **Visibility**: ✅ **Public** (wajib untuk GitHub Pages gratis)
   - Centang: **Add a README file**
4. Klik **Create repository**

---

### Langkah 3 — Upload File ke Repository

Cara mudah lewat browser (tanpa perlu Git CLI):

1. Di halaman repository yang baru dibuat, klik **Add file** → **Upload files**
2. Drag & drop **semua file** dari folder `HeadPoseCollector_Web/`:
   - `index.html`
   - `style.css`
   - `app.js`
   - `face_landmarker.task`
3. Di bagian bawah, tulis commit message: `Initial upload`
4. Klik **Commit changes**

> ⚠️ `face_landmarker.task` berukuran 3.5 MB — tunggu hingga upload selesai.

---

### Langkah 4 — Aktifkan GitHub Pages
1. Di halaman repository, klik tab **Settings**
2. Di menu kiri, klik **Pages**
3. Di bagian **Branch**, pilih: **main** — **(root)**
4. Klik **Save**
5. Tunggu 1–2 menit
6. Muncul link seperti:
   ```
   https://username.github.io/head-pose-collector/
   ```
   ← **Ini link yang dibuka di HP!**

---

### Langkah 5 — Buka di HP

1. Salin link `https://username.github.io/head-pose-collector/`
2. Buka **Chrome** di HP (Chrome paling direkomendasikan)
3. Paste link → tekan Enter
4. Saat diminta izin kamera → **Izinkan**
5. Selesai! Aplikasi langsung berjalan 📱

> **Tip:** Simpan link sebagai bookmark atau buat QR Code di [https://qr.io](https://qr.io) untuk dibagikan ke subjek penelitian.

---

## 📱 Cara Pakai Aplikasi

1. **Isi nama subjek** di form registrasi
2. Pilih **preset pose** (default: 9 pose Multi-PIE)
3. Klik **Mulai Sesi Foto**
4. Arahkan kepala sesuai instruksi di layar
5. Kotak hijau + bar timer → tahan posisi → **SNAP!** foto otomatis
6. Setelah semua pose selesai → klik **⬇ Unduh Semua (.zip)**
7. File ZIP berisi semua foto + `session_info.json` tersimpan di HP

---

## ⌨️ Navigasi

| Tombol | Fungsi |
|--------|--------|
| 📷     | Foto manual sekarang |
| ◀ / ▶  | Ganti target pose |
| ↺      | Foto ulang pose saat ini |
| ✓ Unduh | Unduh semua foto sebagai .zip |
| ☰      | Buka/tutup checklist pose |

---

## 🌐 Kebutuhan Internet

| Kapan | Butuh internet? |
|-------|----------------|
| Buka pertama kali (muat MediaPipe) | ✅ Ya (1x, ~5 MB) |
| Setelah itu (cache browser) | ❌ Tidak |
| Simpan foto ke HP | ❌ Tidak |

> Browser menyimpan (cache) MediaPipe secara otomatis. Setelah pertama kali dibuka, aplikasi bisa digunakan **tanpa internet**.

---

## 📦 Format Output ZIP

```
RockyAmrillah_20261030_1620_a8f1c2/
├── yaw_-60.jpg
├── yaw_-45.jpg
├── yaw_-30.jpg
├── yaw_-15.jpg
├── yaw_+0.jpg
├── yaw_+15.jpg
├── yaw_+30.jpg
├── yaw_+45.jpg
├── yaw_+60.jpg
└── session_info.json     ← Metadata: nama, ID, sudut terukur, timestamp
```
