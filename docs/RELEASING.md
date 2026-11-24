# Panduan Rilis Produksi Canvas Vector Recorder Desktop (`RELEASING.md`)

Dokumen ini memuat Standar Operasional Prosedur (SOP) untuk mempublikasikan rilis produksi resmi aplikasi desktop **Canvas Vector Recorder** (Windows NSIS `.exe` & macOS `.dmg` / `.app`) melalui GitHub Actions serta distribusi auto-update melalui **Mahesapp**.

---

## 1. Sinkronisasi Versi (Wajib di 3 File)

Sebelum membuat commit atau tag rilis baru, periksa tag terakhir terlebih dahulu:

```bash
git tag -l
```

Pastikan nomor versi baru (`x.y.z`, tanpa awalan `v`) ditulis **sama persis** pada ketiga file berikut:
1. [`package.json`](file:///d:/Work/Projects/canvas-vector-recorder-desktop/package.json) (`"version": "x.y.z"`)
2. [`src-tauri/Cargo.toml`](file:///d:/Work/Projects/canvas-vector-recorder-desktop/src-tauri/Cargo.toml) (`version = "x.y.z"`)
3. [`src-tauri/tauri.conf.json`](file:///d:/Work/Projects/canvas-vector-recorder-desktop/src-tauri/tauri.conf.json) (`"version": "x.y.z"`)

Perbarui juga `package-lock.json` dan `src-tauri/Cargo.lock` bila perlu agar versi paket utama tetap sesuai.

> **Penting:** Workflow GitHub Actions (`.github/workflows/publish-desktop.yml`) akan otomatis menggagalkan build apabila salah satu dari ketiga file di atas memiliki versi yang berbeda, atau jika nama tag tidak sesuai dengan `v<version>`.

---

## 2. Prasyarat Secrets GitHub

Pastikan repository GitHub memiliki secrets berikut sebelum menjalankan rilis:
- `LICENSE_PUBLIC_KEY`: Kunci publik lisensi raw base64url, tepat 32 byte (43 karakter tanpa padding).
- `TAURI_SIGNING_PRIVATE_KEY`: Private key updater Tauri (Minisign) untuk menandatangani artefak update.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: Password private key updater (kosongkan jika key tidak menggunakan password).

Public key updater sudah tersimpan di [`src-tauri/tauri.conf.json`](file:///d:/Work/Projects/canvas-vector-recorder-desktop/src-tauri/tauri.conf.json). Jangan pernah commit private key ke repository.

---

## 3. Validasi & Pengujian Sebelum Rilis

Seluruh pengujian dan build wajib lulus 100% sebelum melakukan commit rilis:

```bash
# 1. Typecheck, unit test frontend, dan unit test Rust backend
npm test

# 2. Production frontend bundle
npm run build
```

---

## 4. Publikasi Rilis via GitHub Actions

Setelah ketiga file versi disinkronkan dan seluruh pengujian lulus:

```bash
# 1. Commit perubahan & kenaikan versi
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "chore(release): vX.Y.Z"
git push origin master

# 2. Buat dan push tag rilis (format wajib vX.Y.Z)
git tag vX.Y.Z
git push origin vX.Y.Z
```

Saat tag `vX.Y.Z` masuk ke GitHub (atau dijalankan manual via **Actions → Build & publish desktop release → Run workflow**), workflow [`.github/workflows/publish-desktop.yml`](file:///d:/Work/Projects/canvas-vector-recorder-desktop/.github/workflows/publish-desktop.yml) akan otomatis:
1. Memverifikasi konsistensi versi, tag, `LICENSE_PUBLIC_KEY`, dan `TAURI_SIGNING_PRIVATE_KEY`.
2. Menjalankan pengujian frontend dan Rust di runner CI.
3. Mem-build installer **Windows x64 NSIS (`.exe`)** dan **macOS Intel (`.dmg` & `.app.tar.gz`)**.
4. Menandatangani artefak updater dengan `TAURI_SIGNING_PRIVATE_KEY` (Minisign) dan mengunggah seluruh file beserta `.sig` dan `latest.json` ke **GitHub Releases**.

---

## 5. Alur Auto-Update & Distribusi via Mahesapp

Aplikasi Canvas Vector Recorder menggunakan `@tauri-apps/plugin-updater` dan remote App Config yang terhubung ke proxy backend **Mahesapp**:
- **Endpoint Updater di [`src-tauri/tauri.conf.json`](file:///d:/Work/Projects/canvas-vector-recorder-desktop/src-tauri/tauri.conf.json):**
  `https://www.mahes.app/api/v1/apps/cvr/app-config?format=tauri`
- **Endpoint App Config di [`src-tauri/src/commands.rs`](file:///d:/Work/Projects/canvas-vector-recorder-desktop/src-tauri/src/commands.rs) & [`src/appConfig.ts`](file:///d:/Work/Projects/canvas-vector-recorder-desktop/src/appConfig.ts):**
  `https://www.mahes.app/api/v1/apps/cvr/app-config`

### Cara Kerja Proxy Mahesapp:
1. **Check Update (`?format=tauri`):**
   - Server Mahesapp mengambil `latest.json` dari GitHub Releases `mahesapp/canvas-vector-recorder-desktop` di sisi server menggunakan `GITHUB_RELEASE_TOKEN` (sehingga repository GitHub tetap aman meskipun berstatus **Private** dan URL GitHub tidak pernah terlihat oleh pengguna).
   - Server Mahesapp menyisipkan `release_notes` dari Admin Dashboard Mahesapp dan mengubah seluruh URL download installer menjadi URL proxy Mahesapp (`?download=<target>&version=<version>`).
   - Jika produk sedang di-*lock* (`is_locked`) atau dalam mode *maintenance* di Admin Mahesapp, endpoint mengembalikan `204 No Content` sehingga update ditahan.
2. **App Config Gate:**
   - Saat startup dan setiap 30 menit, aplikasi memeriksa status `is_locked`, `maintenance`, `minimum_version`, dan `update_required` sebelum membuka workspace.
3. **Download & Auto-Install (`?download=<target>`):**
   - Saat pengguna menekan **Install** di dalam aplikasi, aplikasi mengunduh stream binary installer melalui server Mahesapp, memverifikasi signature Minisign (`pubkey` di `tauri.conf.json`), dan langsung menginstal pembaruan.

### Checklist di Admin Dashboard Mahesapp Setelah Rilis:
1. Pastikan variabel environment `GITHUB_RELEASE_TOKEN` aktif di server produksi Mahesapp dan produk `CVR` mengarah ke `mahesapp/canvas-vector-recorder-desktop`.
2. Buka **Admin → Products → Canvas Vector Recorder (`CVR`) → App Config** di Mahesapp untuk:
   - Memperbarui `latest_version` dan daftar `release_notes` yang ingin ditampilkan pada dialog konfirmasi update / `AppConfigGate` di aplikasi.
   - Mengatur `minimum_version` atau `update_required` apabila rilis tersebut bersifat wajib.
   - Mengunggah file installer ke R2 jika ingin memperbarui link unduhan manual bagi pembeli baru di halaman `/account/downloads`.

---

## 6. Workflow CI

Workflow **Continuous integration** (`ci.yml`) berjalan otomatis pada setiap pull request dan push ke branch `master` untuk menguji typecheck frontend, test frontend, dan test Rust tanpa menerbitkan release.
