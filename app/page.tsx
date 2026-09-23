const REPO_URL = "https://github.com/fabious054/github-mcp";
const MCP_ENDPOINT = "https://github-mcp-seven.vercel.app/mcp";

const FEATURES = [
  {
    icon: "◆",
    title: "Branches & commits",
    desc: "Create branches, commit full files, or apply a unified diff to patch just a slice of one.",
  },
  {
    icon: "▤",
    title: "Git Data API",
    desc: "Blob → tree → commit → ref, for large or multi-file changes in a single atomic commit.",
  },
  {
    icon: "⇄",
    title: "Pull requests",
    desc: "Open PRs, list them, and comment — the full review loop without leaving Claude.",
  },
  {
    icon: "☰",
    title: "Issues & board",
    desc: "List, create, and comment on issues — including posting a final QA report.",
  },
  {
    icon: "⌕",
    title: "Code search & read",
    desc: "Read any file's content or search code across a repository.",
  },
  {
    icon: "⚭",
    title: "Multi-account linking",
    desc: "Link more than one GitHub account to the same session — the server figures out which one to use per repository, automatically.",
  },
];

export default function Home() {
  return (
    <main>
      <div className="wrap">
        <nav className="nav">
          <a className="brand" href="/">
            <span className="brand-mark">M</span>
            GitHub MCP
          </a>
          <div className="nav-links">
            <a href="#connect">Connect</a>
            <a href="#features">Features</a>
            <a href="#trust">Security &amp; license</a>
            <a href={REPO_URL}>GitHub</a>
          </div>
        </nav>

        <section className="hero" style={{ borderTop: "none" }}>
          <span className="eyebrow">Model Context Protocol server</span>
          <h1>Real GitHub access for Claude</h1>
          <p className="lead">
            Create branches, commit, open and comment on pull requests,
            manage issues, read files, and search code — every call runs
            with your own GitHub account, never a shared one.
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="#connect">
              Connect in Claude
            </a>
            <a className="btn btn-secondary" href={REPO_URL}>
              View source on GitHub
            </a>
          </div>
        </section>

        <section id="connect">
          <h2>Connect to this instance</h2>
          <p className="section-lead">
            There&apos;s already a running instance of this server — no setup
            or deployment needed to use it.
          </p>
          <div className="connect-panel">
            <ol className="steps">
              <li>
                <div>
                  <strong>Add a custom connector (remote MCP)</strong> in
                  Claude, pointing to the endpoint below.
                </div>
              </li>
              <li>
                <div>
                  <strong>Log in with your own GitHub account</strong> on the
                  real GitHub &quot;Authorize&quot; screen Claude opens — no
                  manual token to generate.
                </div>
              </li>
              <li>
                <div>
                  <strong>Start using the tools.</strong> Every call runs
                  with your own GitHub access. Want more than one account?
                  Use the <code>link_account</code> tool once connected.
                </div>
              </li>
            </ol>
            <div className="endpoint-box">
              <span>{MCP_ENDPOINT}</span>
              <span className="tag">MCP endpoint</span>
            </div>
          </div>
        </section>

        <section id="features">
          <h2>What it can do</h2>
          <p className="section-lead">
            Sixteen tools covering the day-to-day GitHub workflow, plus a
            couple built specifically for working across more than one
            account.
          </p>
          <div className="features-grid">
            {FEATURES.map((f) => (
              <div className="feature-card" key={f.title}>
                <div className="icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="trust">
          <h2>Security &amp; license</h2>
          <p className="section-lead">
            Open source, permissively licensed, and built so the server
            itself never holds onto your primary account&apos;s token.
          </p>
          <div className="trust-row">
            <div className="trust-card">
              <h3>Security policy</h3>
              <p>
                Access model, what was checked before this repo went
                public, and how to report a vulnerability.
              </p>
              <a href={`${REPO_URL}/blob/main/SECURITY.md`}>Read SECURITY.md →</a>
            </div>
            <div className="trust-card">
              <h3>MIT license</h3>
              <p>
                Permissive by design — use, copy, modify, or self-host your
                own instance freely.
              </p>
              <a href={`${REPO_URL}/blob/main/LICENSE`}>Read LICENSE →</a>
            </div>
            <div className="trust-card">
              <h3>Run your own instance</h3>
              <p>
                Full guide for developers: your own GitHub OAuth App,
                environment variables, and deploying on Vercel.
              </p>
              <a href={`${REPO_URL}/blob/main/docs/self-hosting.md`}>
                Read the self-hosting guide →
              </a>
            </div>
          </div>
        </section>

        <footer>
          <span>GitHub MCP — MIT licensed</span>
          <div>
            <a href={REPO_URL}>Repository</a>
            <a href={`${REPO_URL}/blob/main/README.md`}>README</a>
            <a href={`${REPO_URL}/issues`}>Issues</a>
          </div>
        </footer>
      </div>
    </main>
  );
}
