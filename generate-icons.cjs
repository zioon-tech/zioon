/**
 * 简单的 PWA 图标生成脚本
 * 生成纯色 PNG 图标（蓝色背景）
 */

const fs = require('fs');

// 创建一个有效的最小 PNG 文件（使用 zlib 压缩）
function createSimplePNG(width, height, r, g, b) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const widthBuffer = Buffer.alloc(4);
  widthBuffer.writeUInt32BE(width, 0);
  const heightBuffer = Buffer.alloc(4);
  heightBuffer.writeUInt32BE(height, 0);

  const ihdrData = Buffer.concat([
    widthBuffer,
    heightBuffer,
    Buffer.from([8, 6, 0, 0, 0]) // bit depth, color type (RGBA), compression, filter, interlace
  ]);

  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR');
  const ihdrCRC = crc32(Buffer.concat([ihdrType, ihdrData]));
  const ihdrChunk = Buffer.concat([ihdrLength, ihdrType, ihdrData, ihdrCRC]);

  // IDAT chunk (solid color with alpha = 255)
  const scanline = Buffer.alloc(1 + width * 4); // filter + RGBA for each pixel
  scanline[0] = 0; // filter type = none

  for (let i = 0; i < width; i++) {
    scanline[1 + i * 4] = r;
    scanline[1 + i * 4 + 1] = g;
    scanline[1 + i * 4 + 2] = b;
    scanline[1 + i * 4 + 3] = 255; // alpha
  }

  const imageBuffer = Buffer.alloc(height * scanline.length);
  for (let i = 0; i < height; i++) {
    scanline.copy(imageBuffer, i * scanline.length);
  }

  // 使用简单的无压缩数据（对于纯色图像，这仍然有效）
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(imageBuffer);

  const idatData = compressed;
  const idatLength = Buffer.alloc(4);
  idatLength.writeUInt32BE(idatData.length, 0);
  const idatType = Buffer.from('IDAT');
  const idatCRC = crc32(Buffer.concat([idatType, idatData]));
  const idatChunk = Buffer.concat([idatLength, idatType, idatData, idatCRC]);

  // IEND chunk
  const iendLength = Buffer.alloc(4);
  iendLength.writeUInt32BE(0, 0);
  const iendType = Buffer.from('IEND');
  const iendCRC = crc32(iendType);
  const iendChunk = Buffer.concat([iendLength, iendType, iendCRC]);

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// 简单的 CRC32 实现
function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = [];

  // 生成 CRC32 表
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
    table[i] = crc;
  }

  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }

  return Buffer.alloc(4).writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, 0);
}

// 生成图标
const icon192 = createSimplePNG(192, 192, 37, 99, 235); // #2563eb
fs.writeFileSync('public/icon-192.png', icon192);
console.log('✅ Generated icon-192.png');

const icon512 = createSimplePNG(512, 512, 37, 99, 235); // #2563eb
fs.writeFileSync('public/icon-512.png', icon512);
console.log('✅ Generated icon-512.png');

console.log('\n🎉 Icons generated successfully!');
console.log('Tip: Replace these with your actual logo for production.');
