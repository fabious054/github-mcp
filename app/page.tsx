const REPO_URL = "https://github.com/fabious054/github-mcp";
const MCP_ENDPOINT = "https://github-mcp-seven.vercel.app/mcp";
const SITE_URL = "https://github-mcp-seven.vercel.app";

const FEATURES = [
  {
    icon: "◆",
    title: "Branches & commits",
    desc: "Create and delete branches, commit full files, apply a unified diff to patch just a slice of one, or group many files into one atomic commit.",
  },
  {
    icon: "⇄",
    title: "Pull requests",
    desc: "Open, edit, retarget, close or reopen PRs, comment, and read or edit inline review comments — the review loop without leaving Claude.",
  },
  {
    icon: "☰",
    title: "Issues",
    desc: "Create, edit, close as completed, not planned or duplicate, reopen, and organize: labels, assignees, milestone, type and sub-issues.",
  },
  {
    icon: "▦",
    title: "Boards",
    desc: "See a GitHub Project board, add issues, PRs or drafts, and change Status, dates, iterations or any field by name — several at once.",
  },
  {
    icon: "⊞",
    title: "Board structure",
    desc: "Projects, fields and options, iterations, views and status updates, plus labels, milestones and issue types. Every delete shows its impact first and needs confirmation.",
  },
  {
    icon: "↗",
    title: "Activity stats",
    desc: "Commit history with lines changed, and your own activity across every repository you can reach — by period, repository and month, private repos included.",
  },
  {
    icon: "⌕",
    title: "Code search & read",
    desc: "Read any file on any branch, tag or commit, or search code across a repository.",
  },
  {
    icon: "▤",
    title: "Git Data API",
    desc: "Blob → tree → commit → ref, for large or multi-file changes, reusing unchanged files without resending them.",
  },
  {
    icon: "⚭",
    title: "Multi-account linking",
    desc: "Link more than one GitHub account to the same session — the server picks the one that can write to each repository, and asks you whenever it can't tell for sure.",
  },
];

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "GitHub MCP",
  description:
    "An MCP server that gives Claude real GitHub access: branches, commits, pull requests, issues, project boards and activity stats — authorized with your own GitHub login, never a shared token.",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any (remote MCP server)",
  url: SITE_URL,
  license: `${REPO_URL}/blob/main/LICENSE`,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

export default function Home() {
  return (
    <main>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
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
            Commit code, run pull requests, organize issues, manage your
            GitHub Project boards and see your activity stats — every call
            runs with your own GitHub account, never a shared one.
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
            Seventy-eight tools covering the day-to-day GitHub workflow,
            from a single commit to a whole project board.
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
            Open source, permissively licensed, and built so your GitHub
            token is stored encrypted and only ever handed back to you.
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
            <div className="trust-card">
              <h3>What it asks GitHub for</h3>
              <p>
                <code>repo</code>, <code>project</code> and{" "}
                <code>admin:org</code>. GitHub still checks your own role on
                every call: the connector never does more than you can.
              </p>
              <a href={`${REPO_URL}/blob/main/README.md#what-the-connector-asks-github-for`}>
                Why each permission →
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
