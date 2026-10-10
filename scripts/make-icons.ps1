# Builds every icon Nyx ships from build/icon-source.png: the .ico/.png for the
# installer and exe, the window icon, the in-app logo, and the two tray states.
# Needs only Windows PowerShell 5.1 (System.Drawing) — no npm dependencies.
# Run after replacing build/icon-source.png:  npm run icons
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class IconMaker
{
    static bool IsBackground(byte[] p, int i)
    {
        int m = Math.Min(p[i], Math.Min(p[i + 1], p[i + 2]));
        return m >= 235;
    }

    static byte[] ToBytes(Bitmap src, out int w, out int h)
    {
        w = src.Width; h = src.Height;
        using (Bitmap argb = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(argb)) { g.DrawImage(src, 0, 0, w, h); }
            BitmapData d = argb.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            byte[] bytes = new byte[w * h * 4];
            Marshal.Copy(d.Scan0, bytes, 0, bytes.Length);
            argb.UnlockBits(d);
            return bytes;
        }
    }

    static Bitmap FromBytes(byte[] bytes, int w, int h)
    {
        Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        Marshal.Copy(bytes, 0, d.Scan0, bytes.Length);
        bmp.UnlockBits(d);
        return bmp;
    }

    // The source art is a glassy tile centred on a large, opaque dark canvas
    // (the tile fills only ~two thirds of it), which made the shortcut and
    // taskbar icon look tiny. Find the tile by how far each pixel is from the
    // canvas colour, crop to it, and give it rounded, anti-aliased corners.
    public static Bitmap LoadTile(string path)
    {
        int w, h;
        byte[] p;
        using (Bitmap src = new Bitmap(path)) { p = ToBytes(src, out w, out h); }

        int[] corners = new int[] { 0, (w - 1) * 4, ((h - 1) * w) * 4, ((h - 1) * w + w - 1) * 4 };
        int bgB = 0, bgG = 0, bgR = 0;
        foreach (int c in corners) { bgB += p[c]; bgG += p[c + 1]; bgR += p[c + 2]; }
        bgB /= 4; bgG /= 4; bgR /= 4;

        int minX = w, minY = h, maxX = -1, maxY = -1;
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int i = (y * w + x) * 4;
                if (p[i + 3] < 8) continue;
                int dist = Math.Abs(p[i] - bgB) + Math.Abs(p[i + 1] - bgG) + Math.Abs(p[i + 2] - bgR);
                if (dist <= 24) continue;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }

        int side = Math.Max(maxX - minX + 1, maxY - minY + 1) + 2;
        int cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        int x0 = Math.Max(0, Math.Min(w - side, cx - side / 2));
        int y0 = Math.Max(0, Math.Min(h - side, cy - side / 2));
        side = Math.Min(side, Math.Min(w - x0, h - y0));

        double radius = side * 0.235;
        double half = side / 2.0;
        byte[] o = new byte[side * side * 4];
        for (int y = 0; y < side; y++)
        {
            for (int x = 0; x < side; x++)
            {
                int si = ((y0 + y) * w + (x0 + x)) * 4;
                int di = (y * side + x) * 4;
                double qx = Math.Abs(x + 0.5 - half) - (half - radius);
                double qy = Math.Abs(y + 0.5 - half) - (half - radius);
                double d = Math.Sqrt(Math.Max(qx, 0) * Math.Max(qx, 0) + Math.Max(qy, 0) * Math.Max(qy, 0))
                           + Math.Min(Math.Max(qx, qy), 0) - radius;
                double a = Math.Max(0.0, Math.Min(1.0, 0.5 - d));
                o[di] = p[si]; o[di + 1] = p[si + 1]; o[di + 2] = p[si + 2];
                o[di + 3] = (byte)(a * p[si + 3]);
            }
        }
        return FromBytes(o, side, side);
    }

    static Bitmap Resize(Bitmap src, int size)
    {
        Bitmap cur = src;
        while (cur.Width >= size * 2)
        {
            Bitmap half = ResizeOnce(cur, cur.Width / 2);
            if (cur != src) cur.Dispose();
            cur = half;
        }
        Bitmap result = ResizeOnce(cur, size);
        if (cur != src) cur.Dispose();
        return result;
    }

    static Bitmap ResizeOnce(Bitmap src, int size)
    {
        Bitmap dst = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(dst))
        using (ImageAttributes attrs = new ImageAttributes())
        {
            attrs.SetWrapMode(WrapMode.TileFlipXY);
            g.Clear(Color.Transparent);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(src, new Rectangle(0, 0, size, size), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, attrs);
        }
        return dst;
    }

    static byte[] PngBytes(Bitmap bmp)
    {
        using (MemoryStream ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
    }

    static void WriteIco(string path, Bitmap master, int[] sizes)
    {
        List<byte[]> pngs = new List<byte[]>();
        foreach (int s in sizes) { using (Bitmap b = Resize(master, s)) { pngs.Add(PngBytes(b)); } }
        using (BinaryWriter bw = new BinaryWriter(File.Create(path)))
        {
            bw.Write((ushort)0); bw.Write((ushort)1); bw.Write((ushort)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                byte dim = (byte)(sizes[i] >= 256 ? 0 : sizes[i]);
                bw.Write(dim); bw.Write(dim); bw.Write((byte)0); bw.Write((byte)0);
                bw.Write((ushort)1); bw.Write((ushort)32);
                bw.Write((uint)pngs[i].Length); bw.Write((uint)offset);
                offset += pngs[i].Length;
            }
            foreach (byte[] png in pngs) bw.Write(png);
        }
    }

    static Bitmap Grayscale(Bitmap src)
    {
        Bitmap dst = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
        float[][] m = new float[][] {
            new float[] { 0.30f, 0.30f, 0.30f, 0, 0 },
            new float[] { 0.59f, 0.59f, 0.59f, 0, 0 },
            new float[] { 0.11f, 0.11f, 0.11f, 0, 0 },
            new float[] { 0, 0, 0, 1, 0 },
            new float[] { 0.03f, 0.03f, 0.03f, 0, 1 }
        };
        using (Graphics g = Graphics.FromImage(dst))
        using (ImageAttributes attrs = new ImageAttributes())
        {
            attrs.SetColorMatrix(new ColorMatrix(m));
            g.DrawImage(src, new Rectangle(0, 0, src.Width, src.Height), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, attrs);
        }
        return dst;
    }

    static Bitmap WithStatusDot(Bitmap src)
    {
        Bitmap dst = new Bitmap(src);
        float s = src.Width;
        float r = s * 0.17f, cx = s * 0.74f, cy = s * 0.74f;
        using (Graphics g = Graphics.FromImage(dst))
        {
            g.SmoothingMode = SmoothingMode.HighQuality;
            float ring = r + s * 0.05f;
            using (Brush ringBrush = new SolidBrush(Color.FromArgb(255, 20, 21, 27)))
                g.FillEllipse(ringBrush, cx - ring, cy - ring, ring * 2, ring * 2);
            using (Brush dot = new SolidBrush(Color.FromArgb(255, 34, 197, 94)))
                g.FillEllipse(dot, cx - r, cy - r, r * 2, r * 2);
        }
        return dst;
    }

    static void SavePng(string path, Bitmap bmp)
    {
        File.WriteAllBytes(path, PngBytes(bmp));
    }

    public static void Run(string root)
    {
        string build = Path.Combine(root, "build");
        string assets = Path.Combine(root, "electron", "assets");
        Directory.CreateDirectory(assets);

        using (Bitmap master = LoadTile(Path.Combine(build, "icon-source.png")))
        {
            WriteIco(Path.Combine(build, "icon.ico"), master, new int[] { 16, 24, 32, 48, 64, 128, 256 });
            using (Bitmap b = Resize(master, 256)) SavePng(Path.Combine(build, "icon.png"), b);
            using (Bitmap b = Resize(master, 256)) SavePng(Path.Combine(assets, "app-icon-256.png"), b);
            using (Bitmap b = Resize(master, 128)) SavePng(Path.Combine(assets, "app-icon-128.png"), b);
            using (Bitmap tray = Resize(master, 32))
            using (Bitmap off = Grayscale(tray))
            using (Bitmap on = WithStatusDot(tray))
            {
                SavePng(Path.Combine(assets, "tray-disconnected.png"), off);
                SavePng(Path.Combine(assets, "tray-connected.png"), on);
            }
        }
    }
}
"@

[IconMaker]::Run($root)
Write-Host "Icons written to build/ and electron/assets/"
