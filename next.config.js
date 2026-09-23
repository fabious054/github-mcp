/** @type {import('next').NextConfig} */

const securityHeaders = [
  // Prevents the browser from guessing a response's content type — blocks
  // a class of MIME-sniffing attacks.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // This app is never meant to be embedded in an iframe (including the
  // GitHub "Authorize" redirect flow, which navigates the top-level
  // window) — blocks clickjacking.
  { key: "X-Frame-Options", value: "DENY" },
  // Don't leak the full referrer URL (which can carry query params) to
  // third-party destinations.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Force HTTPS for a year, including subdomains, and allow preload-list
  // submission.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // This server doesn't need any browser hardware/location API.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
