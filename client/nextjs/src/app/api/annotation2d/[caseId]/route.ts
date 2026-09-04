import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const dynamic = "force-dynamic";

function projectRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  const toCrc = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);
  return Buffer.concat([len, toCrc, crcBuf]);
}

function encodeGrayscalePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // non-interlaced

  const stride = width + 1;
  const rawScanlines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    rawScanlines[y * stride] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      rawScanlines[y * stride + 1 + x] = pixels[y * width + x];
    }
  }

  const idatData = zlib.deflateSync(rawScanlines);
  return Buffer.concat([
    sig,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idatData),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  const stem = req.nextUrl.searchParams.get("stem");
  const raw = req.nextUrl.searchParams.get("raw") === "true";

  if (!stem) {
    return NextResponse.json({ error: "missing stem query param" }, { status: 400 });
  }

  const root = projectRoot();
  const maskPath = path.join(root, "data", "annotations2d", caseId, `${stem}.mask.png`);

  if (!fs.existsSync(maskPath)) {
    return NextResponse.json({ exists: false });
  }

  if (raw) {
    const buf = fs.readFileSync(maskPath);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  }

  const st = fs.statSync(maskPath);
  return NextResponse.json({
    exists: true,
    savedAt: st.mtime.toISOString(),
    size: st.size,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  const stem = req.nextUrl.searchParams.get("stem");

  if (!stem) {
    return NextResponse.json({ error: "missing stem query param" }, { status: 400 });
  }

  const root = projectRoot();
  const annDir = path.join(root, "data", "annotations2d", caseId);
  fs.mkdirSync(annDir, { recursive: true });
  const maskPath = path.join(annDir, `${stem}.mask.png`);

  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await req.json();
    if (body.width && body.height && body.pixels) {
      // Direct array of uint8 values (0, 1, 2, 3)
      const pixels = new Uint8Array(body.pixels);
      let hasNonZero = false;
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] !== 0) {
          hasNonZero = true;
          break;
        }
      }
      if (!hasNonZero && req.nextUrl.searchParams.get("allowEmpty") !== "true") {
        return NextResponse.json(
          { error: "Cannot save empty annotation. Mask has no painted pixels." },
          { status: 400 },
        );
      }
      const pngBuf = encodeGrayscalePng(body.width, body.height, pixels);
      fs.writeFileSync(maskPath, pngBuf);
    } else if (body.dataUrl) {
      const base64Data = body.dataUrl.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(maskPath, Buffer.from(base64Data, "base64"));
    } else {
      return NextResponse.json({ error: "invalid payload format" }, { status: 400 });
    }
  } else {
    // Raw binary stream
    const arrayBuffer = await req.arrayBuffer();
    fs.writeFileSync(maskPath, Buffer.from(arrayBuffer));
  }

  const st = fs.statSync(maskPath);

  // Log annotation save
  const logFile = path.join(root, "data", "annotations2d_log.json");
  try {
    const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
    log.push({
      caseId,
      stem,
      savedAt: st.mtime.toISOString(),
    });
    fs.writeFileSync(logFile, JSON.stringify(log.slice(-100), null, 2));
  } catch {
    // Non-fatal
  }

  return NextResponse.json({
    ok: true,
    savedAt: st.mtime.toISOString(),
    path: `data/annotations2d/${caseId}/${stem}.mask.png`,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  const stem = req.nextUrl.searchParams.get("stem");

  if (!stem) {
    return NextResponse.json({ error: "missing stem query param" }, { status: 400 });
  }

  const root = projectRoot();
  const maskPath = path.join(root, "data", "annotations2d", caseId, `${stem}.mask.png`);

  if (fs.existsSync(maskPath)) {
    try {
      fs.unlinkSync(maskPath);
    } catch (e) {
      return NextResponse.json({ error: `failed to delete mask: ${e}` }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, deleted: true });
}

