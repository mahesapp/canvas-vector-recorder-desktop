# Regresi ikon foto mengilap

Input adalah gambar lampiran pengguna, ditemukan identik di `Downloads/Screenshot 2026-10-21 at 11.06.38.png`. Salinan asli 1440 × 1450 ada di `source.png`, SHA-256 `5d1283c410e6b646b211a9b7a8d6e28ae0d354fc9a153f994e45655ba373ab19`. Baseline dibekukan dari commit `c2b7b51` sebelum perubahan. Uji menjalankan fungsi produksi `traceAuto`; SVG tidak diedit manual. Raster kerja 1017 × 1024 dibuat oleh `resizeRaster` produksi.

## Cacat dan penyebab

Preview Auto merekomendasikan 10 warna dan cleanup 0 karena mendeteksi detail halus. Kandidat preview memilih 13 warna. Pada raster akhir, kilau putih masuk warna latar `#e4e4e5` karena palet kekurangan slot. Pemeriksaan ulang 16 warna sebelumnya hanya berjalan untuk cleanup ≥4 sehingga detail halus tidak mendapat kesempatan pemulihan warna. Hasil juga memiliki banyak fragmen kecil dari batas gradasi.

Percobaan penambahan menjadi 16 warna tanpa cleanup memulihkan putih tetapi menghasilkan 1448 path dan 7882 segmen; guard kompleksitas menolaknya. Percobaan cleanup 4 memulihkan putih tetapi galat tepi meningkat menjadi .003667, sehingga tidak dipilih. Ini alasan tidak melonggarkan batas penerimaan untuk memaksakan kandidat tersebut.

## Perubahan produksi

- Pemeriksaan palet akhir juga mencakup cleanup 0. Kandidat 16 warna menggunakan cleanup minimal 2 untuk membuang singleton; kandidat dengan cleanup aktif mempertahankan ambangnya.
- Kandidat tetap harus memperbaiki galat keseluruhan ≥5%, menjaga galat tepi dalam batas 5%, memperbaiki skor gabungan ≥2%, dan memenuhi batas path/segmen/ukuran. Batas jumlah percobaan tetap berlaku. Kandidat buruk/gagal mempertahankan hasil sebelumnya; pembatalan diteruskan.
- Pilihan **Minimal · <2 px** tersedia di editor dan dapat disimpan/dimuat kembali. Regresi memastikan aksen dua piksel tetap ada, sedangkan singleton dibersihkan.
- Tidak ada perubahan pada algoritme tracing manual atau kebijakan penghapusan putih. Perubahan berada pada kandidat mode Auto dan dukungan pengaturannya.

## Hasil gambar penuh

| Ukuran | Sebelum | Sesudah |
| --- | ---: | ---: |
| Warna | 13 | 16 |
| Cleanup | 0 | 2 |
| Toleransi | .2 | .35 |
| Path / kontur | 409 | 320 |
| Segmen | 2851 | 3005 |
| Galat scene produksi | .0005818723 | .0003991365 |
| Galat tepi produksi | .0031177581 | .0030521808 |
| Kilau | `#e4e4e5` (abu-abu latar) | `#f5fbf9` (putih) |

Galat scene turun **31,4%**, galat tepi turun **2,1%**, jumlah path turun **21,8%**. Segmen bertambah **5,4%** karena warna/detail tambahan. `before.json` dan `after.json` menyimpan opsi, seleksi, diagnostics dan metrik lengkap. Timing run berlangsung bersamaan dengan tes lain; tidak digunakan untuk mengklaim perbaikan performa. Pemeriksaan tambahan memang membutuhkan satu trace lagi.

Rasterisasi independen dengan CairoSVG juga membaik: MSE RGBA .0006439449 → .0005049464; MAE RGB 4.15463 → 3.08490. Nilai ini berbeda dari evaluator produksi karena rasterizer/antialias berbeda; lihat `independent-metrics.json`.

Artefak review: `comparison.png`, `highlights-comparison.png`, `tag-comparison.png`, dan SVG editable `after.svg`. Kilau putih pulih; bentuk utama, lingkaran matahari, dan lubang berwarna pada tag tetap ada.

## Pengujian

- TypeScript dan build Vite lulus.
- Rust: **46 lulus**.
- Frontend: **147 lulus, 1 gagal lama** dari 148 tes. Kegagalan yang sama sudah ada pada baseline: `tests/bridge.test.mjs`, tes startup, mengharapkan elemen logo PNG yang sudah tidak ada serta sekaligus mengharapkan durasi 0 dan 8000 ms. Tidak diubah dalam pekerjaan vektorisasi ini.
- Tes tracing sesudah perluasan cakupan cleanup 2: **39 lulus**.
- Fixture terkompresi 381 × 384 menjalankan seluruh pipeline Auto, memeriksa pemulihan putih, galat gambar/tepi dan kompleksitas. Tes juga mencakup penolakan kandidat buruk, kegagalan opsional, pembatalan, dan persistensi pengaturan minimal.

## Reproduksi

Dengan Node/dependensi proyek dan Python yang memiliki Pillow, CairoSVG, numpy:

```sh
PYTHON=/path/to/python node RND/tracing-quality/glossy-icon-v15/audit.mjs after
/path/to/python RND/tracing-quality/glossy-icon-v15/render.py
npm run test:frontend
npm run compile
npm run build
npm run test:rust
```

## Batas hasil

Ini validasi pipeline/worker yang digunakan UI, bukan pengujian interaktif aplikasi desktop terpasang. Gradasi sumber masih disederhanakan menjadi maksimal 16 warna datar; bayangan jingga pada matahari belum terwakili sebagai warna terpisah. Pada pembesaran besar masih tampak ketidakrataan batas warna di bagian dalam lubang tag dan sedikit fragmentasi. Hasil membaik, tetapi tidak identik dengan sumber dan belum merupakan rekonstruksi gradasi penuh. Batas ini tidak disembunyikan oleh metrik keseluruhan.
