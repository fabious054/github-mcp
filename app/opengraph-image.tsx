import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "GitHub MCP — Real GitHub access for Claude";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #0b0d12 0%, #171a22 100%)",
          color: "#e7e9ee",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 40,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "linear-gradient(135deg, #7c8cff, #4b3fff)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              fontWeight: 800,
              color: "#ffffff",
            }}
          >
            M
          </div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>GitHub MCP</div>
        </div>
        <div
          style={{
            fontSize: 56,
            fontWeight: 800,
            lineHeight: 1.1,
            maxWidth: 900,
          }}
        >
          Real GitHub access for Claude
        </div>
        <div
          style={{
            fontSize: 26,
            color: "#9aa2b1",
            marginTop: 24,
            maxWidth: 820,
          }}
        >
          Branches, commits, pull requests, issues and code search —
          authorized with your own GitHub login.
        </div>
      </div>
    ),
    { ...size }
  );
}
