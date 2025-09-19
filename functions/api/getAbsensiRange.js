// functions/api/getAbsensiRange.js
// Cloudflare Pages Functions (ESM)

const DEFAULT_REPO   = "mrdickymiswardi/server";
const DEFAULT_BRANCH = "main";

const dec = new TextDecoder();
const b64decode = (b64 = "") => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

// ---------- Helpers ----------
function normKelas(k) {
  if (!k) return "";
  let v = String(k).trim().replace(/-/g, "_");
  if (!/^kelas_/.test(v)) v = `kelas_${v}`;
  return v;
}

function generateDateRange(startDate, endDate) {
  const dates = [];
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return dates;

  // normalisasi ke tanggal (tanpa waktu)
  let cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  const end = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()));
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10)); // YYYY-MM-DD
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function fetchGithubJsonFile({ repo, path, token, branch }) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cf-pages-getAbsensiRange/1.0",
    },
  });

  if (res.status === 404) return { ok: false, status: 404, data: null };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, data: text || null };
  }

  const payload = await res.json();
  try {
    const decoded = b64decode(payload.content || "");
    return { ok: true, status: 200, data: JSON.parse(decoded) };
  } catch {
    return { ok: false, status: 422, data: `Invalid JSON in ${path}` };
  }
}

async function buildIdToNisMap({ repo, kelas, token, branch }) {
  const rosterPath = `${kelas}.json`; // contoh: "kelas_01.json"
  const roster = await fetchGithubJsonFile({ repo, path: rosterPath, token, branch });
  if (!roster.ok) return { idToNis: {}, nisMeta: {} };

  const idToNis = {};
  const nisMeta = {};
  (roster.data || []).forEach((s) => {
    const idNum = typeof s?.id === "number" ? s.id : parseInt(s?.id, 10);
    const nis = s?.nis ? String(s.nis).trim() : null;
    if (Number.isFinite(idNum) && nis) idToNis[idNum] = nis;
    if (nis) {
      nisMeta[nis] = {
        nama: s?.nama || "",
        semester: s?.semester != null ? parseInt(s.semester, 10) : null,
      };
    }
  });
  return { idToNis, nisMeta };
}

// ---------- Handlers ----------
export const onRequestOptions = () => json({}, 204);

export async function onRequestGet({ request, env }) {
  const TOKEN  = env.GITHUB_TOKEN;
  const REPO   = env.GITHUB_REPO   || DEFAULT_REPO;
  const BRANCH = env.GITHUB_BRANCH || DEFAULT_BRANCH;

  if (!TOKEN) return json({ error: "GITHUB_TOKEN tidak terpasang di environment." }, 500);

  const { searchParams } = new URL(request.url);
  const kelasRaw = (searchParams.get("kelas") || "").trim();
  const start    = (searchParams.get("start") || "").trim();
  const end      = (searchParams.get("end")   || "").trim();

  if (!kelasRaw || !start || !end) {
    return json({ error: "Parameter 'kelas', 'start', dan 'end' wajib diisi" }, 400);
  }

  const kelas = normKelas(kelasRaw);
  const tanggalList = generateDateRange(start, end);
  if (!tanggalList.length) return json({ error: "Rentang tanggal tidak valid." }, 400);

  // peta id -> nis dari roster kelas
  const { idToNis } = await buildIdToNisMap({ repo: REPO, kelas, token: TOKEN, branch: BRANCH });

  const hasilGabungan = [];

  for (const tanggal of tanggalList) {
    const filePath = `absensi/${kelas}_${tanggal}.json`;
    const res = await fetchGithubJsonFile({ repo: REPO, path: filePath, token: TOKEN, branch: BRANCH });

    if (res.status === 404) continue; // skip jika tidak ada file hari itu
    if (!res.ok) {
      // log ringan di payload agar terlihat di Network tab
      hasilGabungan.push({ _warn: true, file: filePath, status: res.status, error: res.data || "fetch-failed" });
      continue;
    }

    const daily = Array.isArray(res.data) ? res.data : [];
    daily.forEach((it) => {
      if (it && !it.tanggal) it.tanggal = tanggal;
      if (!it?.nis) {
        const idNum = typeof it?.id === "number" ? it.id : parseInt(it?.id, 10);
        const mapped = Number.isFinite(idNum) ? idToNis[idNum] : null;
        if (mapped) it.nis = String(mapped);
      }
    });

    hasilGabungan.push(...daily);
  }

  return json(hasilGabungan, 200);
}

export async function onRequest(ctx) {
  const m = ctx.request.method.toUpperCase();
  if (!["GET", "OPTIONS"].includes(m)) return json({ message: "Method Not Allowed" }, 405);
}
