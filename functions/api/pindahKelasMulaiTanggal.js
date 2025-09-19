// /functions/api/pindahKelasMulaiTanggal.js
// POST /api/pindahKelasMulaiTanggal
// Body JSON:
// {
//   "kelasAsal": "kelas_01" | "01",
//   "kelasTujuan": "kelas_02" | "02",
//   "ids": ["12","34"],          // optional
//   "nises": ["A123","B456"],    // optional
//   "santriIds": ["legacy..."],  // optional (alias lama)
//   "startDate": "YYYY-MM-DD",
//   "idMap": [{ oldId:"12", newId:"112" }, ...] // optional, remap id saat dipindah
// }
// ENV: GITHUB_TOKEN (contents:read/write)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const OWNER_REPO = "yanwarmtb/server";
const BRANCH     = "main";
const API_BASE   = `https://api.github.com/repos/${OWNER_REPO}/contents`;

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github.v3+json",
  "Content-Type": "application/json",
  "User-Agent": "cf-pages-functions",
});

const withRef = (url) => `${url}?ref=${encodeURIComponent(BRANCH)}`;
const normKelas = (k) => (String(k || "").startsWith("kelas_") ? String(k) : `kelas_${k}`);

// === base64 helpers (UTF-8 safe, tanpa Buffer) ===
const dec = new TextDecoder();
const enc = new TextEncoder();
const b64decode = (b64 = "") => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
};
const b64encode = (str = "") => {
  const bytes = enc.encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// --- GitHub helpers ---
async function readDir(dir, token) {
  const res = await fetch(withRef(`${API_BASE}/${dir}`), { headers: ghHeaders(token) });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: err };
  }
  return { ok: true, data: await res.json() };
}

async function readJsonFile(path, token) {
  const res = await fetch(withRef(`${API_BASE}/${path}`), { headers: ghHeaders(token) });
  if (res.status === 404) return { ok: true, exists: false, sha: null, data: [] };
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: err };
  }
  const json = await res.json();
  let arr = [];
  try { arr = JSON.parse(b64decode(json.content || "")); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return { ok: true, exists: true, sha: json.sha, data: arr };
}

async function writeJsonFile(path, arrayData, token, sha = null, message = "update") {
  const body = {
    message,
    content: b64encode(JSON.stringify(arrayData, null, 2)),
    committer: { name: "admin", email: "admin@local" }, // opsional
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(`${API_BASE}/${path}`, {
    method: "PUT",
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: err };
  }
  return { ok: true };
}

// --- util helpers ---
const mapIdIfNeeded = (row, idMap) => {
  if (!Array.isArray(idMap) || idMap.length === 0) return row;
  const oldId = (row.id ?? "").toString();
  const found = idMap.find((m) => String(m.oldId) === oldId);
  if (found && found.newId) return { ...row, id: String(found.newId) };
  return row;
};

const matchRow = (row, keySet, nameSetLower) => {
  const rid  = (row.id   ?? "").toString();
  const rnis = (row.nis  ?? "").toString();
  const rnmL = String(row.nama ?? "").toLowerCase();
  return (rid && keySet.has(rid)) || (rnis && keySet.has(rnis)) || (rnmL && nameSetLower.has(rnmL));
};

const sortByIdNumeric = (arr) =>
  [...arr].sort((a, b) => {
    const ai = parseInt(a?.id ?? 0, 10) || 0;
    const bi = parseInt(b?.id ?? 0, 10) || 0;
    return ai - bi;
  });

export async function onRequest({ request, env }) {
  // CORS preflight
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST")   return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const token = env.GITHUB_TOKEN || env.MTQ_TOKEN; // fallback kalau env lama masih dipakai
  if (!token) return json(500, { error: "GITHUB_TOKEN tidak tersedia" });

  let body = {};
  try { body = await request.json(); }
  catch { return json(400, { error: "Body bukan JSON valid" }); }

  let { kelasAsal, kelasTujuan, ids, nises, santriIds, startDate, idMap } = body || {};
  if (!kelasAsal || !kelasTujuan) return json(400, { error: "Wajib: kelasAsal & kelasTujuan" });
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
    return json(400, { error: "startDate harus format YYYY-MM-DD" });

  const asal   = normKelas(kelasAsal);
  const tujuan = normKelas(kelasTujuan);

  const idsArr   = Array.isArray(ids) ? ids : [];
  const nisesArr = Array.isArray(nises) ? nises : [];
  const legacy   = Array.isArray(santriIds) ? santriIds : [];
  const rawKeys  = [...idsArr, ...nisesArr, ...legacy]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (rawKeys.length === 0)
    return json(400, { error: "Wajib: minimal satu id/nis (ids/nises/santriIds)" });

  const keySet = new Set(rawKeys);
  const nameSetLower = new Set(rawKeys.map((v) => v.toLowerCase()));

  // Baca daftar file di folder absensi
  const dir = await readDir("absensi", token);
  if (!dir.ok) return json(500, { error: "Gagal baca folder absensi", detail: dir.error });

  const asalFiles = (Array.isArray(dir.data) ? dir.data : [])
    .filter((f) => f?.type === "file" && new RegExp(`^${asal}_\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f.name))
    .map((f) => ({
      name: f.name,
      path: `absensi/${f.name}`,
      date: f.name.replace(`${asal}_`, "").replace(".json", ""),
    }))
    .filter((item) => item.date >= startDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (asalFiles.length === 0)
    return json(404, { error: "Tidak ada file absensi yang cocok" });

  const report = [];
  let totalMoved = 0;

  for (const f of asalFiles) {
    const tanggal = f.date;
    const srcPath = f.path;
    const dstPath = `absensi/${tujuan}_${tanggal}.json`;

    // ambil asal
    const src = await readJsonFile(srcPath, token);
    if (!src.ok) { report.push({ tanggal, moved: 0, note: "gagal baca asal" }); continue; }
    if (!src.exists || !Array.isArray(src.data) || src.data.length === 0) {
      report.push({ tanggal, moved: 0, note: "asal kosong/tidak ada" }); continue;
    }

    const toMoveRaw = src.data.filter((r) => matchRow(r, keySet, nameSetLower));
    if (toMoveRaw.length === 0) { report.push({ tanggal, moved: 0, note: "tidak ada match" }); continue; }

    const toMove    = toMoveRaw.map((r) => mapIdIfNeeded(r, idMap));
    const remaining = src.data.filter((r) => !matchRow(r, keySet, nameSetLower));

    // ambil tujuan
    const dst = await readJsonFile(dstPath, token);
    if (!dst.ok) { report.push({ tanggal, moved: 0, note: "gagal baca tujuan" }); continue; }
    const dstArr = Array.isArray(dst.data) ? dst.data : [];

    // gabung + dedup id/nis
    const merged = [...dstArr, ...toMove];
    const seenId = new Set();
    const seenNis = new Set();
    const deduped = [];
    for (const r of merged) {
      const rid  = (r?.id  ?? "").toString();
      const rnis = (r?.nis ?? "").toString();
      const k1 = rid  ? `id:${rid}`   : null;
      const k2 = rnis ? `nis:${rnis}` : null;
      if (k1 && seenId.has(k1)) continue;
      if (k2 && seenNis.has(k2)) continue;
      if (k1) seenId.add(k1);
      if (k2) seenNis.add(k2);
      deduped.push(r);
    }
    const sortedCombined = sortByIdNumeric(deduped);

    // tulis tujuan
    const okDst = await writeJsonFile(
      dstPath,
      sortedCombined,
      token,
      dst.exists ? dst.sha : null,
      dst.exists
        ? `Append ${toMove.length} santri -> ${tujuan} (${tanggal}, sorted)`
        : `Create ${tujuan} (${tanggal}) & seed ${toMove.length} santri (sorted)`
    );
    if (!okDst.ok) { report.push({ tanggal, moved: 0, note: `gagal tulis tujuan (${okDst.status})` }); continue; }

    // tulis asal (hapus yang dipindah)
    const sortedRemaining = sortByIdNumeric(remaining);
    const okSrc = await writeJsonFile(
      srcPath,
      sortedRemaining,
      token,
      src.sha || null,
      `Remove ${toMoveRaw.length} santri pindah dari ${asal} (${tanggal}, sorted)`
    );
    if (!okSrc.ok) { report.push({ tanggal, moved: 0, note: `gagal tulis asal (${okSrc.status})` }); continue; }

    totalMoved += toMove.length;
    report.push({ tanggal, moved: toMove.length });
  }

  return json(200, { success: true, totalMoved, details: report });
}
