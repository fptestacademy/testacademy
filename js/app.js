/* Fieldbook Training. Plain JavaScript, no build step.
   Pages are hash routes (#/learn, #/lesson/slug) so the site works on any static host. */
(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const app = document.getElementById("app");
  const topbar = document.getElementById("topbar");
  const utility = document.getElementById("utility");
  const footer = document.getElementById("footer");
  const SITE = cfg.SITE_NAME || "Training";
  const PAGE_SIZE = Number(cfg.PAGE_SIZE) > 0 ? Number(cfg.PAGE_SIZE) : 12;
  const REMEMBER_KEY = "rememberMe";
  const TAB_KEY = "tabSession";
  const BASE_URL = location.origin + location.pathname;
  const RETURN_KEY = "returnTo";

  // Read the URL before Supabase touches it (email links come back with tokens in the hash).
  const initialHash = location.hash;
  const cameFromRecovery = initialHash.includes("type=recovery");
  let flash = "";
  if (initialHash.includes("error_description=")) {
    const m = initialHash.match(/error_description=([^&]+)/);
    if (m) flash = decodeURIComponent(m[1].replace(/\+/g, " "));
  }

  const configured =
    cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON");

  let sb = null;
  let session = null;
  let profile = null;
  let catalog = null;       // { paths, courses, lessons } without lesson bodies
  let renderToken = 0;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const linkTo = (hash) => BASE_URL + hash;
  const md = (text) => DOMPurify.sanitize(marked.parse(text || ""));

  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  async function share(title, hash) {
    const url = linkTo(hash);
    try {
      if (navigator.share) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      window.prompt("Copy this link:", url);
    }
  }

  function parseRoute() {
    const h = location.hash.startsWith("#/") ? location.hash.slice(2) : "";
    const [name, ...rest] = h.split("/");
    return { name: name || "", param: decodeURIComponent(rest.join("/")) };
  }

  function go(hash) {
    if (location.hash === hash) render(); else location.hash = hash;
  }

  function goAfterAuth() {
    let target = "#/learn";
    try {
      const saved = localStorage.getItem(RETURN_KEY);
      if (saved && saved.startsWith("#/")) target = saved;
      localStorage.removeItem(RETURN_KEY);
    } catch (_) {}
    go(target);
  }

  // ---------- data ----------
  async function loadProfile() {
    if (!session) { profile = null; return; }
    const { data } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    profile = data || { full_name: session.user.user_metadata?.full_name || "", email: session.user.email, is_admin: false };
  }

  async function loadCatalog() {
    if (catalog) return catalog;
    const [p, c, l] = await Promise.all([
      sb.from("paths").select("*").order("sort"),
      sb.from("courses").select("*").order("sort"),
      sb.from("lessons").select("id,course_id,slug,title,kind,minutes,sort,video_url").order("sort"),
    ]);
    const err = p.error || c.error || l.error;
    if (err) throw err;
    catalog = { paths: p.data, courses: c.data, lessons: l.data };
    return catalog;
  }

  async function loadDone() {
    const { data, error } = await sb.from("lesson_completions")
      .select("lesson_id,completed_at").eq("user_id", session.user.id);
    if (error) throw error;
    return new Map(data.map((r) => [r.lesson_id, r.completed_at]));
  }

  async function loadMyCerts() {
    const { data, error } = await sb.from("certificates")
      .select("id,course_id,issued_at").eq("user_id", session.user.id).order("issued_at", { ascending: false });
    if (error) throw error;
    return data;
  }

  const lessonsOf = (courseId) => catalog.lessons.filter((l) => l.course_id === courseId);
  function courseStats(course, done) {
    const ls = lessonsOf(course.id);
    const n = ls.filter((l) => done.has(l.id)).length;
    return { lessons: ls, done: n, total: ls.length, minutes: ls.reduce((a, l) => a + l.minutes, 0),
             complete: ls.length > 0 && n === ls.length, next: ls.find((l) => !done.has(l.id)) };
  }

  // ---------- header, utility bar, footer ----------
  const NAV = [
    ["#/guides", "guides", "Resource Library"],
    ["#/videos", "videos", "Video Library"],
    ["#/learn", "learn", "Courses"],
  ];

  function renderUtility() {
    const links = Array.isArray(cfg.UTILITY_LINKS) ? cfg.UTILITY_LINKS.filter((l) => l && l.label && l.url) : [];
    utility.innerHTML = links.length
      ? `<div class="wrap utility-in">${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("")}</div>`
      : "";
  }

  function renderFooter() {
    footer.innerHTML = `
      <nav class="footer-nav" aria-label="Footer">
        ${NAV.map(([h, , label]) => `<a href="${h}">${label}</a>`).join("")}
        ${session ? `<a href="#/certificates">Certificates</a>` : ""}
      </nav>
      <span>&copy; ${new Date().getFullYear()} ${esc(SITE)}</span>`;
  }

  function renderTopbar() {
    const r = parseRoute().name;
    const cur = (n) => (r === n ? ' aria-current="page"' : "");
    const links = NAV.map(([h, n, label]) => `<a href="${h}"${cur(n)}>${label}</a>`).join("");
    let who = "";
    if (session) {
      who = `<div class="who">
          <span class="who-name">${esc(profile?.full_name || session.user.email)}</span>
          <button class="btn btn-ghost btn-sm" id="signout" type="button">Sign out</button>
        </div>`;
    } else if (configured) {
      who = `<div class="who">
          <a class="btn btn-ghost btn-sm" href="#/login"${cur("login")}>Sign in</a>
          <a class="btn btn-accent btn-sm" href="#/signup">Create account</a>
        </div>`;
    }
    topbar.innerHTML = `
      <a class="brand" href="#/${session ? "learn" : ""}"><img src="icon.svg" alt=""><span>${esc(SITE)}</span></a>
      <button class="menu-btn" id="menubtn" type="button" aria-expanded="false" aria-controls="navarea" aria-label="Menu"><span></span><span></span><span></span></button>
      <div class="nav-area" id="navarea">
        <nav class="nav" aria-label="Main">${links}${session ? `<a href="#/certificates"${cur("certificates")}>Certificates</a>` : ""}${profile?.is_admin ? `<a href="#/admin"${cur("admin")}>Learners</a><a href="#/manage"${cur("manage")}>Content</a>` : ""}</nav>
        ${who}
      </div>`;
    const mb = document.getElementById("menubtn"), na = document.getElementById("navarea");
    mb.addEventListener("click", () => {
      const open = na.classList.toggle("open");
      mb.setAttribute("aria-expanded", String(open));
    });
    const so = document.getElementById("signout");
    if (so) so.addEventListener("click", async () => {
      await sb.auth.signOut();
      session = null; profile = null; catalog = null;
      go("#/");
    });
    renderFooter();
  }

  // ---------- views: public ----------
  function viewSetup() {
    return { html: `
      <section class="narrow pad">
        <h1>Connect your Supabase project</h1>
        <p>The site is running, but it has no database yet. Three steps:</p>
        <ol class="steps">
          <li>Create a free project at supabase.com.</li>
          <li>Open SQL Editor, paste in <code>supabase/schema.sql</code> from this repo, and press Run.</li>
          <li>Copy the Project URL and anon public key from Project Settings, API, into <code>js/config.js</code>.</li>
        </ol>
        <p class="muted">The README has the full walkthrough.</p>
      </section>` };
  }

  function authShell(title, intro, fields, submitLabel, footer) {
    return `
      <section class="narrow pad">
        <h1>${title}</h1>
        ${intro ? `<p class="notice">${intro}</p>` : ""}
        <form id="authform" class="form" novalidate>
          ${fields}
          <p class="form-error" id="formerr" role="alert" hidden></p>
          <button class="btn btn-primary" type="submit">${submitLabel}</button>
        </form>
        <div class="form-foot">${footer}</div>
      </section>`;
  }
  const field = (id, label, type, extra = "") =>
    `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" required ${extra}>`;

  function bindAuth(handler) {
    const form = document.getElementById("authform");
    const errEl = document.getElementById("formerr");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      const btn = form.querySelector("button[type=submit]");
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "Working…";
      try {
        const vals = Object.fromEntries(new FormData(form).entries());
        await handler(vals);
      } catch (err) {
        errEl.textContent = err.message || "Something went wrong. Try again.";
        errEl.hidden = false;
      } finally {
        if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = label; }
      }
    });
  }

  function pendingNotice() {
    let pending = false;
    try { pending = !!localStorage.getItem(RETURN_KEY); } catch (_) {}
    return pending ? "That page is for members. Create a free account or sign in, and you will go straight to it." : "";
  }

  const signinFields = () =>
    field("email", "Email", "email", 'autocomplete="email"') +
    field("password", "Password", "password", 'autocomplete="current-password"') +
    `<label class="check"><input type="checkbox" name="remember" checked> Remember me</label>`;

  const signupFields = () =>
    field("full_name", "Full name (printed on your certificates)", "text", 'autocomplete="name"') +
    field("email", "Email", "email", 'autocomplete="email"') +
    field("password", "Password (8 characters or more)", "password", 'autocomplete="new-password" minlength="8"');

  // Banner on the left, a form card on the right. Used for the landing page, sign in, and sign up.
  function bannerShell({ cardTitle, intro, fields, submitLabel, links, side }) {
    return `
      <section class="banner">
        <div class="wrap banner-in">
          <div>
            <h1>${esc(cfg.HERO_TITLE || "Training designed with you in mind")}</h1>
            <p class="lede">${esc(cfg.HERO_TEXT || "")}</p>
            ${side}
          </div>
          <div class="card-form">
            <h2>${cardTitle}</h2>
            ${intro ? `<p class="notice">${intro}</p>` : ""}
            <form id="authform" class="form" novalidate>
              ${fields}
              <p class="form-error" id="formerr" role="alert" hidden></p>
              <button class="btn btn-primary" type="submit">${submitLabel}</button>
            </form>
            <div class="form-links">${links}</div>
          </div>
        </div>
      </section>`;
  }

  const newAccountSide = `
    <div class="newacct">
      <h2>Need a new account?</h2>
      <p>Get started now. Your progress and certificates are saved to it.</p>
      <a class="btn btn-accent" href="#/signup">Create an account</a>
    </div>`;
  const haveAccountSide = `
    <div class="newacct">
      <h2>Already have an account?</h2>
      <p>Sign in to pick up where you stopped.</p>
      <a class="btn btn-ghost-light" href="#/login">Sign in</a>
    </div>`;

  function bindSignin() {
    bindAuth(async ({ email, password, remember }) => {
      const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(error.message === "Invalid login credentials" ? "That email and password do not match an account." : error.message);
      setRemember(!!remember);
      session = data.session; await loadProfile(); goAfterAuth();
    });
  }

  function setRemember(on) {
    try {
      localStorage.setItem(REMEMBER_KEY, on ? "1" : "0");
      sessionStorage.setItem(TAB_KEY, "1");
    } catch (_) {}
  }

  function viewHome() {
    return {
      full: true,
      html: bannerShell({ cardTitle: "Welcome", intro: flash || pendingNotice(), fields: signinFields(), submitLabel: "Sign in",
        links: `<a href="#/reset">Forgot password?</a><a href="#/signup">Create an account</a>`, side: newAccountSide }) + `
      <section class="wrap three">
        <div><h2>Courses</h2><p>Lessons run in a set order inside each course, and progress is saved to your account.</p></div>
        <div><h2>Resource Library</h2><p>Every troubleshooting guide in one searchable place, written to be followed with the equipment in front of you.</p></div>
        <div><h2>Certificates</h2><p>Finish every lesson in a course and download a certificate with an ID anyone can check on this site.</p></div>
      </section>`,
      bind: bindSignin,
    };
  }

  function viewLogin() {
    return {
      full: true,
      html: bannerShell({ cardTitle: "Sign in", intro: flash || pendingNotice(), fields: signinFields(), submitLabel: "Sign in",
        links: `<a href="#/reset">Forgot password?</a><a href="#/signup">Create an account</a>`, side: newAccountSide }),
      bind: bindSignin,
    };
  }

  function viewSignup() {
    return {
      full: true,
      html: bannerShell({ cardTitle: "Create your account", intro: flash || pendingNotice(), fields: signupFields(), submitLabel: "Create account",
        links: `<span></span><a href="#/login">Already have an account? Sign in</a>`, side: haveAccountSide }),
      bind() {
        bindAuth(async ({ full_name, email, password }) => {
          if (!full_name.trim()) throw new Error("Enter your full name.");
          if (password.length < 8) throw new Error("Use a password with 8 characters or more.");
          const { data, error } = await sb.auth.signUp({
            email: email.trim(), password,
            options: { data: { full_name: full_name.trim() }, emailRedirectTo: BASE_URL },
          });
          if (error) throw error;
          if (data.user && data.user.identities && data.user.identities.length === 0)
            throw new Error("An account with this email already exists. Sign in instead.");
          setRemember(true);
          if (data.session) {
            session = data.session; await loadProfile(); goAfterAuth();
          } else {
            app.innerHTML = `<div class="wrap"><section class="narrow pad"><h1>Check your email</h1>
              <p>We sent a confirmation link to <strong>${esc(email)}</strong>. Open it on this device and you will be signed in and taken to the page you wanted.</p></section></div>`;
          }
        });
      },
    };
  }

  function viewReset() {
    return {
      html: authShell("Reset your password", "", field("email", "Email", "email", 'autocomplete="email"'),
        "Send reset link", `<a href="#/login">Back to sign in</a>`),
      bind() {
        bindAuth(async ({ email }) => {
          const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: BASE_URL });
          if (error) throw error;
          app.innerHTML = `<section class="narrow pad"><h1>Check your email</h1><p>If an account exists for that address, a reset link is on its way.</p></section>`;
        });
      },
    };
  }

  function viewNewPassword() {
    if (!session) return { html: `<section class="narrow pad"><h1>Reset link expired</h1><p>Request a new one from the <a href="#/reset">reset page</a>.</p></section>` };
    return {
      html: authShell("Choose a new password", "", field("password", "New password (8 characters or more)", "password", 'autocomplete="new-password" minlength="8"'),
        "Save password", ""),
      bind() {
        bindAuth(async ({ password }) => {
          if (password.length < 8) throw new Error("Use a password with 8 characters or more.");
          const { error } = await sb.auth.updateUser({ password });
          if (error) throw error;
          toast("Password saved");
          go("#/learn");
        });
      },
    };
  }

  async function viewVerify(id) {
    const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    let row = null;
    if (ok) {
      const { data } = await sb.rpc("verify_certificate", { p_id: id });
      row = data && data[0];
    }
    return { html: `<section class="narrow pad">
      <h1>Certificate check</h1>
      ${row ? `<div class="verify ok"><p class="verify-head">This certificate is valid.</p>
          <p><strong>${esc(row.full_name)}</strong> completed <strong>${esc(row.course_title)}</strong> on ${fmtDate(row.issued_at)}.</p></div>`
            : `<div class="verify bad"><p class="verify-head">No certificate matches this ID.</p><p>Check that the link was copied in full.</p></div>`}
      <p class="muted small">Certificate ID: ${esc(id)}</p></section>` };
  }

  // ---------- views: members ----------
  // Shared card grid with search and pagination. items: [{html, hay}] ; hay is the lowercase search text.
  function gridPage(items, { q, page, emptyText }) {
    const hits = q ? items.filter((it) => q.split(/\s+/).every((w) => it.hay.includes(w))) : items;
    const pages = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const slice = hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const btn = (n, label, cur) => `<button type="button" data-page="${n}"${cur ? ' aria-current="page"' : ""}${n < 1 || n > pages ? " disabled" : ""}>${label}</button>`;
    let pager = "";
    if (pages > 1) {
      const nums = [];
      for (let n = 1; n <= pages; n++) if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n);
      let last = 0;
      const parts = nums.map((n) => { const gap = n - last > 1 ? `<span aria-hidden="true">…</span>` : ""; last = n; return gap + btn(n, n, n === page); });
      pager = `<nav class="pager" aria-label="Pages">${btn(page - 1, "‹")}${parts.join("")}${btn(page + 1, "›")}</nav>`;
    }
    const html = slice.length ? `<ul class="grid">${slice.map((it) => it.html).join("")}</ul>${pager}` : `<div class="empty">${emptyText}</div>`;
    return { html, page };
  }

  function bindGrid(container, draw) {
    let q = "", page = 1;
    const search = document.getElementById("q");
    const paint = () => { const r = draw(q, page); page = r.page; container.innerHTML = r.html; };
    if (search) search.addEventListener("input", () => { q = search.value.trim().toLowerCase(); page = 1; paint(); });
    container.addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]");
      if (!b || b.disabled) return;
      page = Number(b.dataset.page); paint();
      container.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return { paint, setQuery: (v) => { q = v; page = 1; paint(); }, reset: () => { page = 1; paint(); } };
  }

  function courseCard(c, st) {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    const label = st.complete ? "Review" : st.done ? "Continue" : "Start";
    const thumb = c.image_url ? `<img src="${esc(c.image_url)}" alt="" loading="lazy">` : "";
    return `<li class="card ${st.complete ? "is-complete" : ""}">
      <a class="thumb ${c.image_url ? "" : "thumb-plain"}" href="#/course/${esc(c.slug)}" tabindex="-1" aria-hidden="true">${thumb}</a>
      <div class="card-body">
        <span class="card-kind">Course, ${st.total} lessons, about ${st.minutes} min</span>
        <h3><a href="#/course/${esc(c.slug)}">${esc(c.title)}</a></h3>
        <p class="card-desc">${esc(c.description)}</p>
        <div class="card-foot">
          <div class="bar" role="img" aria-label="${st.done} of ${st.total} lessons complete"><span style="width:${pct}%"></span></div>
          <a class="btn btn-sm ${st.complete ? "btn-ghost" : "btn-primary"}" href="#/course/${esc(c.slug)}">${label}</a>
        </div>
      </div></li>`;
  }

  async function viewLearn() {
    await loadCatalog();
    const done = await loadDone();
    if (!catalog.paths.length)
      return { html: `<section class="pad"><h1>No courses yet</h1><p>Add paths, courses, and lessons in the Supabase Table Editor, or run the sample content in <code>supabase/schema.sql</code>.</p></section>` };

    const all = catalog.courses.map((c) => ({ course: c, st: courseStats(c, done) }));
    const open = all.filter((x) => !x.st.complete && x.st.next);
    const pick = open.find((x) => x.st.done > 0) || open[0];   // a course already started wins
    const upNext = pick ? { course: pick.course, lesson: pick.st.next, started: pick.st.done > 0 } : null;

    const first = (profile?.full_name || "").split(" ")[0];
    return {
      html: `
      <section class="page-title">
        <h1>${first ? `Welcome back, ${esc(first)}` : "Courses"}</h1>
        ${upNext ? `<a class="upnext" href="#/lesson/${esc(upNext.lesson.slug)}">
            <span class="upnext-label">${upNext.started ? "Continue where you stopped" : "Start here"}</span>
            <span class="upnext-title">${esc(upNext.lesson.title)}</span>
            <span class="upnext-course">${esc(upNext.course.title)}</span></a>`
          : `<p class="notice">You have finished every course. Your certificates are on the <a href="#/certificates">certificates page</a>.</p>`}
        <div class="toolbar">
          <div class="chips" id="chips" role="group" aria-label="Filter by learning path">
            <button class="chip" type="button" data-path="" aria-pressed="true">All courses</button>
            ${catalog.paths.map((p) => `<button class="chip" type="button" data-path="${p.id}" aria-pressed="false">${esc(p.title)}</button>`).join("")}
          </div>
          <label for="q" class="sr">Search courses</label>
          <input id="q" class="search" type="search" placeholder="Search courses" autocomplete="off">
        </div>
        <div id="grid"></div>
      </section>`,
      bind() {
        let pathId = "";
        const items = all.map((x) => ({ pathId: String(x.course.path_id), html: courseCard(x.course, x.st),
          hay: (x.course.title + " " + x.course.description).toLowerCase() }));
        const grid = bindGrid(document.getElementById("grid"), (q, page) =>
          gridPage(items.filter((it) => !pathId || it.pathId === pathId), { q, page, emptyText: "No courses match. Try another word or clear the filter." }));
        document.getElementById("chips").addEventListener("click", (e) => {
          const b = e.target.closest(".chip"); if (!b) return;
          pathId = b.dataset.path;
          document.querySelectorAll("#chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
          grid.reset();
        });
        grid.paint();
      },
    };
  }

  function ytId(url) {
    const m = String(url || "").match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  async function viewVideos() {
    await loadCatalog();
    const vids = catalog.lessons.filter((l) => l.kind === "video");
    const items = vids.map((l) => {
      const course = catalog.courses.find((c) => c.id === l.course_id);
      const id = ytId(l.video_url);
      const thumb = id ? `<img src="https://img.youtube.com/vi/${id}/hqdefault.jpg" alt="" loading="lazy">` : "";
      return { hay: (l.title + " " + (course?.title || "")).toLowerCase(), html: `<li class="card">
        <a class="thumb thumb-play ${id ? "" : "thumb-plain"}" href="#/lesson/${esc(l.slug)}" tabindex="-1" aria-hidden="true">${thumb}</a>
        <div class="card-body">
          <span class="card-kind">Video, ${l.minutes} min</span>
          <h3><a href="#/lesson/${esc(l.slug)}">${esc(l.title)}</a></h3>
          <p class="card-desc">${esc(course?.title || "")}</p>
        </div></li>` };
    });
    return {
      html: `<section class="page-title">
        <h1>Video Library</h1>
        <div class="toolbar">
          <p class="muted" style="margin:0">${vids.length} video${vids.length === 1 ? "" : "s"} across every course</p>
          <label for="q" class="sr">Search videos</label>
          <input id="q" class="search" type="search" placeholder="Search videos" autocomplete="off">
        </div>
        <div id="grid"></div></section>`,
      bind() {
        bindGrid(document.getElementById("grid"), (q, page) => gridPage(items, { q, page, emptyText: "No videos match that search." })).paint();
      },
    };
  }

  async function viewCourse(slug) {
    await loadCatalog();
    const course = catalog.courses.find((c) => c.slug === slug);
    if (!course) return notFound("course");
    const [done, certs] = await Promise.all([loadDone(), loadMyCerts()]);
    const st = courseStats(course, done);
    let cert = certs.find((c) => c.course_id === course.id);
    if (st.complete && !cert) {
      const { data } = await sb.rpc("issue_certificate", { p_course_id: course.id });
      if (data) cert = { id: data, course_id: course.id, issued_at: new Date().toISOString() };
    }
    const path = catalog.paths.find((p) => p.id === course.path_id);
    return {
      html: `
      <section class="pad">
        <p class="crumb"><a href="#/learn">Learn</a> / ${esc(path?.title || "")}</p>
        <div class="page-head">
          <h1>${esc(course.title)}</h1>
          <button class="btn btn-ghost" id="share" type="button">Share course</button>
        </div>
        <p class="lede">${esc(course.description)}</p>
        <p class="muted">${st.done} of ${st.total} lessons complete, about ${st.minutes} minutes in total</p>
        <ol class="rail rail-live">
          ${st.lessons.map((l) => {
            const isDone = done.has(l.id);
            const isNow = !isDone && st.next && st.next.id === l.id;
            return `<li class="stop ${isDone ? "done" : isNow ? "now" : ""}"><span class="dot"></span>
              <div class="stop-body"><span class="kind">${l.kind === "video" ? "Video" : "Guide"}, ${l.minutes} min${isDone ? ", completed" : ""}</span>
              <a class="stop-title" href="#/lesson/${esc(l.slug)}">${esc(l.title)}</a></div></li>`;
          }).join("")}
          <li class="stop cert ${cert ? "done" : ""}"><span class="dot"></span>
            <div class="stop-body"><span class="stop-title">${cert ? `Certificate issued ${fmtDate(cert.issued_at)}` : "Certificate, issued when every lesson is complete"}</span>
            ${cert ? `<a href="#/certificates">Go to your certificates</a>` : ""}</div></li>
        </ol>
      </section>`,
      bind() { document.getElementById("share").addEventListener("click", () => share(course.title, `#/course/${course.slug}`)); },
    };
  }

  function videoEmbed(url) {
    if (!url) return "";
    const yt = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/)([\w-]{11})/);
    if (yt) return `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0" title="Lesson video" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
    if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) return `<div class="video"><video controls preload="metadata" src="${esc(url)}"></video></div>`;
    return `<p><a href="${esc(url)}" target="_blank" rel="noopener">Open the lesson video</a></p>`;
  }

  async function viewLesson(slug) {
    await loadCatalog();
    const meta = catalog.lessons.find((l) => l.slug === slug);
    if (!meta) return notFound("lesson");
    const [{ data: lesson, error }, done] = await Promise.all([
      sb.from("lessons").select("*").eq("id", meta.id).single(), loadDone()]);
    if (error) throw error;
    const course = catalog.courses.find((c) => c.id === lesson.course_id);
    const siblings = lessonsOf(course.id);
    const i = siblings.findIndex((l) => l.id === lesson.id);
    const prev = siblings[i - 1], next = siblings[i + 1];
    const doneAt = done.get(lesson.id);

    return {
      html: `
      <article class="lesson pad">
        <p class="crumb"><a href="#/learn">Learn</a> / <a href="#/course/${esc(course.slug)}">${esc(course.title)}</a></p>
        <div class="page-head">
          <h1>${esc(lesson.title)}</h1>
          <button class="btn btn-ghost" id="share" type="button">Share lesson</button>
        </div>
        <p class="muted">Lesson ${i + 1} of ${siblings.length}, ${lesson.kind === "video" ? "video" : "guide"}, about ${lesson.minutes} minutes</p>
        ${videoEmbed(lesson.video_url)}
        <div class="prose">${md(lesson.body)}</div>
        <div class="complete-box" id="completebox">
          ${doneAt ? `<p class="done-note">Completed on ${fmtDate(doneAt)}</p>`
                   : `<button class="btn btn-primary" id="complete" type="button">Mark lesson complete</button>`}
          ${next ? `<a class="btn btn-ghost" href="#/lesson/${esc(next.slug)}">Next lesson: ${esc(next.title)}</a>`
                 : `<a class="btn btn-ghost" href="#/course/${esc(course.slug)}">Back to course</a>`}
        </div>
        ${prev ? `<p class="small"><a href="#/lesson/${esc(prev.slug)}">Previous lesson: ${esc(prev.title)}</a></p>` : ""}
      </article>`,
      bind() {
        document.getElementById("share").addEventListener("click", () => share(lesson.title, `#/lesson/${lesson.slug}`));
        const btn = document.getElementById("complete");
        if (!btn) return;
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const { error: e1 } = await sb.from("lesson_completions").insert({ user_id: session.user.id, lesson_id: lesson.id });
          if (e1 && e1.code !== "23505") { btn.disabled = false; toast("Could not save. Check your connection and try again."); return; }
          const nowDone = await loadDone();
          const st = courseStats(course, nowDone);
          if (st.complete) {
            await sb.rpc("issue_certificate", { p_course_id: course.id });
            document.getElementById("completebox").innerHTML = `
              <p class="done-note">Course complete. Your certificate is ready.</p>
              <a class="btn btn-primary" href="#/certificates">Get your certificate</a>`;
          } else {
            toast("Lesson marked complete");
            render();
          }
        });
      },
    };
  }

  async function viewGuides() {
    await loadCatalog();
    const { data, error } = await sb.from("lessons").select("id,slug,title,body,course_id,minutes").eq("kind", "guide").order("title");
    if (error) throw error;
    const excerpt = (body) => String(body || "").replace(/[#*`>_\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
    const items = data.map((g) => {
      const course = catalog.courses.find((c) => c.id === g.course_id)?.title || "";
      return { hay: (g.title + " " + g.body).toLowerCase(), html: `<li class="card">
        <div class="card-body">
          <span class="card-kind">Guide, ${g.minutes} min${course ? `, ${esc(course)}` : ""}</span>
          <h3><a href="#/lesson/${esc(g.slug)}">${esc(g.title)}</a></h3>
          <p class="card-desc">${esc(excerpt(g.body))}</p>
        </div></li>` };
    });
    return {
      html: `<section class="page-title">
        <h1>Resource Library</h1>
        <div class="toolbar">
          <p class="muted" style="margin:0">Troubleshooting guides from every course. Search by symptom, part, or error.</p>
          <label for="q" class="sr">Search guides</label>
          <input id="q" class="search" type="search" placeholder="Search guides" autocomplete="off">
        </div>
        <div id="grid"></div></section>`,
      bind() {
        bindGrid(document.getElementById("grid"), (q, page) => gridPage(items, { q, page, emptyText: "No guide mentions that. Try a symptom or a part name, such as “no internet” or “cable”." })).paint();
      },
    };
  }

  function certificatePdf(name, courseTitle, issuedAt, id) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const W = 297, H = 210, cx = W / 2;
    doc.setFillColor(245, 247, 249); doc.rect(0, 0, W, H, "F");
    doc.setDrawColor(18, 50, 74); doc.setLineWidth(1.6); doc.rect(10, 10, W - 20, H - 20);
    doc.setLineWidth(0.4); doc.rect(14, 14, W - 28, H - 28);
    doc.setFillColor(242, 183, 5); doc.rect(cx - 20, 32, 40, 2.4, "F");
    doc.setTextColor(18, 50, 74);
    doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.text(SITE, cx, 28, { align: "center" });
    doc.setFontSize(34); doc.text("Certificate of completion", cx, 58, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(14); doc.setTextColor(91, 107, 120);
    doc.text("This certifies that", cx, 78, { align: "center" });
    doc.setFont("times", "bolditalic"); doc.setFontSize(36); doc.setTextColor(14, 34, 51);
    doc.text(name || "Learner", cx, 98, { align: "center", maxWidth: W - 60 });
    doc.setFont("helvetica", "normal"); doc.setFontSize(14); doc.setTextColor(91, 107, 120);
    doc.text("has completed every lesson in the course", cx, 116, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(18, 50, 74);
    doc.text(courseTitle, cx, 132, { align: "center", maxWidth: W - 60 });
    doc.setFont("helvetica", "normal"); doc.setFontSize(12); doc.setTextColor(14, 34, 51);
    doc.text(`Issued ${fmtDate(issuedAt)}`, cx, 156, { align: "center" });
    doc.setFontSize(9); doc.setTextColor(91, 107, 120);
    doc.text(`Certificate ID ${id}`, cx, 178, { align: "center" });
    doc.text(`Check this certificate at ${linkTo("#/verify/" + id)}`, cx, 184, { align: "center" });
    doc.save(`certificate-${courseTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`);
  }

  async function viewCertificates() {
    await loadCatalog();
    const certs = await loadMyCerts();
    const title = (c) => catalog.courses.find((x) => x.id === c.course_id)?.title || "Course";
    return {
      html: `<section class="pad">
        <h1>Your certificates</h1>
        ${certs.length ? `<ul class="cert-list">${certs.map((c) => `
            <li><div><h2>${esc(title(c))}</h2><p class="muted">Issued ${fmtDate(c.issued_at)}</p></div>
              <div class="row"><button class="btn btn-primary" data-pdf="${c.id}" type="button">Download PDF</button>
              <button class="btn btn-ghost" data-link="${c.id}" type="button">Copy verification link</button></div></li>`).join("")}</ul>`
          : `<p>No certificates yet. Finish every lesson in a course and its certificate appears here.</p>
             <a class="btn btn-primary" href="#/learn">Go to your courses</a>`}
      </section>`,
      bind() {
        app.querySelectorAll("[data-pdf]").forEach((b) => b.addEventListener("click", () => {
          const c = certs.find((x) => x.id === b.dataset.pdf);
          certificatePdf(profile?.full_name, title(c), c.issued_at, c.id);
        }));
        app.querySelectorAll("[data-link]").forEach((b) => b.addEventListener("click", () => share("Certificate", `#/verify/${b.dataset.link}`)));
      },
    };
  }

  async function viewAdmin() {
    if (!profile?.is_admin)
      return { html: `<section class="narrow pad"><h1>Administrators only</h1><p>Your account does not have admin access. The README explains how to grant it.</p></section>` };
    const [{ data: rows, error }, { count }] = await Promise.all([
      sb.rpc("admin_progress"),
      sb.from("profiles").select("id", { count: "exact", head: true }),
    ]);
    if (error) throw error;
    const courses = [...new Set(rows.map((r) => r.course_title))].sort();
    const certified = rows.filter((r) => r.certificate_id).length;
    let shown = rows;

    const table = () => shown.length ? `
      <div class="table-scroll"><table>
        <thead><tr><th>Learner</th><th>Email</th><th>Course</th><th>Progress</th><th>Last activity</th><th>Completed</th></tr></thead>
        <tbody>${shown.map((r) => `<tr>
          <td>${esc(r.full_name || "(no name)")}</td><td>${esc(r.email)}</td><td>${esc(r.course_title)}</td>
          <td>${r.lessons_done} of ${r.lessons_total}</td><td>${fmtDate(r.last_activity)}</td>
          <td>${r.certified_at ? `<span class="pill">${fmtDate(r.certified_at)}</span>` : `<span class="muted">In progress</span>`}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">No learners match these filters.</p>`;

    return {
      html: `<section class="pad">
        <div class="page-head"><h1>Learner progress</h1>
          <div class="row"><a class="btn btn-ghost" href="#/manage">Edit content</a>
          <button class="btn btn-ghost" id="csv" type="button">Download CSV</button></div></div>
        <dl class="stats">
          <div><dt>Registered learners</dt><dd>${count ?? "?"}</dd></div>
          <div><dt>Courses started</dt><dd>${rows.length}</dd></div>
          <div><dt>Courses completed</dt><dd>${certified}</dd></div>
        </dl>
        <div class="filters">
          <div><label for="fq">Learner</label><input id="fq" type="search" placeholder="Name or email"></div>
          <div><label for="fc">Course</label><select id="fc"><option value="">All courses</option>${courses.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
          <div><label for="fs">Status</label><select id="fs"><option value="">Any status</option><option value="done">Completed</option><option value="open">In progress</option></select></div>
        </div>
        <div id="tbl">${table()}</div>
      </section>`,
      bind() {
        const fq = document.getElementById("fq"), fc = document.getElementById("fc"), fs = document.getElementById("fs");
        const apply = () => {
          const q = fq.value.trim().toLowerCase();
          shown = rows.filter((r) =>
            (!q || (r.full_name + " " + r.email).toLowerCase().includes(q)) &&
            (!fc.value || r.course_title === fc.value) &&
            (!fs.value || (fs.value === "done") === !!r.certificate_id));
          document.getElementById("tbl").innerHTML = table();
        };
        [fq, fc, fs].forEach((el) => el.addEventListener("input", apply));
        document.getElementById("csv").addEventListener("click", () => {
          const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
          const lines = [["Learner", "Email", "Course", "Lessons done", "Lessons total", "Last activity", "Completed on", "Certificate ID"]]
            .concat(shown.map((r) => [r.full_name, r.email, r.course_title, r.lessons_done, r.lessons_total, r.last_activity, r.certified_at || "", r.certificate_id || ""]));
          const blob = new Blob([lines.map((l) => l.map(cell).join(",")).join("\n")], { type: "text/csv" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob); a.download = "learner-progress.csv";
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
      },
    };
  }


  // ---------- views: content editor (admins) ----------
  const slugify = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 80);
  const adminOnly = () => ({ html: `<section class="narrow pad"><h1>Administrators only</h1><p>Your account does not have admin access. The README explains how to grant it.</p></section>` });

  async function saveRow(table, id, values) {
    const q = id ? sb.from(table).update(values).eq("id", id) : sb.from(table).insert(values);
    const { data, error } = await q.select("id").single();
    if (error) {
      if (error.code === "23505") throw new Error("That link name (slug) is already used. Choose another.");
      throw new Error(error.message);
    }
    catalog = null;
    return data.id;
  }

  async function deleteRow(table, id) {
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) throw new Error(error.message);
    catalog = null;
  }

  // Swap sort values with the neighbour above or below.
  async function moveRow(table, list, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = list[i], b = list[j];
    const sa = a.sort === b.sort ? j + 1 : b.sort, sb_ = a.sort === b.sort ? i + 1 : a.sort;
    const r1 = await sb.from(table).update({ sort: sa }).eq("id", a.id);
    const r2 = await sb.from(table).update({ sort: sb_ }).eq("id", b.id);
    if (r1.error || r2.error) throw new Error((r1.error || r2.error).message);
    catalog = null;
  }

  function bindEditForm(handler) {
    const form = document.getElementById("editform");
    const errEl = document.getElementById("formerr");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try { await handler(Object.fromEntries(new FormData(form).entries())); }
      catch (err) { errEl.textContent = err.message || "Could not save."; errEl.hidden = false; btn.disabled = false; }
    });
  }

  // Title field fills the slug until someone edits the slug by hand.
  function bindSlug() {
    const t = document.getElementById("title"), sl = document.getElementById("slug");
    if (!t || !sl) return;
    let manual = !!sl.value;
    sl.addEventListener("input", () => { manual = sl.value !== ""; });
    t.addEventListener("input", () => { if (!manual) sl.value = slugify(t.value); });
  }

  async function viewManage() {
    if (!profile?.is_admin) return adminOnly();
    await loadCatalog();
    const paths = catalog.paths, courses = catalog.courses, lessons = catalog.lessons;

    const lessonRow = (l, i, list) => `
      <li class="edit-row">
        <span class="edit-kind">${l.kind === "video" ? "Video" : "Guide"}, ${l.minutes} min</span>
        <a class="edit-title" href="#/manage/lesson/${l.id}">${esc(l.title)}</a>
        <span class="edit-actions">
          <button type="button" class="icon-btn" data-move="lessons:${l.id}:-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>&#8593;</button>
          <button type="button" class="icon-btn" data-move="lessons:${l.id}:1" aria-label="Move down" ${i === list.length - 1 ? "disabled" : ""}>&#8595;</button>
          <a class="btn btn-ghost btn-sm" href="#/manage/lesson/${l.id}">Edit</a>
          <a class="btn btn-ghost btn-sm" href="#/lesson/${esc(l.slug)}">View</a>
        </span>
      </li>`;

    const courseBlock = (c, i, list) => {
      const ls = lessonsOf(c.id);
      return `
      <div class="edit-course">
        <div class="edit-head">
          <div>
            <h3><a href="#/manage/course/${c.id}">${esc(c.title)}</a></h3>
            <span class="muted small">${ls.length} lesson${ls.length === 1 ? "" : "s"}</span>
          </div>
          <span class="edit-actions">
            <button type="button" class="icon-btn" data-move="courses:${c.id}:-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>&#8593;</button>
            <button type="button" class="icon-btn" data-move="courses:${c.id}:1" aria-label="Move down" ${i === list.length - 1 ? "disabled" : ""}>&#8595;</button>
            <a class="btn btn-ghost btn-sm" href="#/manage/course/${c.id}">Edit course</a>
            <a class="btn btn-primary btn-sm" href="#/manage/lesson/new?course=${c.id}">Add lesson</a>
          </span>
        </div>
        ${ls.length ? `<ol class="edit-list">${ls.map(lessonRow).join("")}</ol>` : `<p class="muted small edit-empty">No lessons yet.</p>`}
      </div>`;
    };

    const pathBlock = (p, i, list) => {
      const cs = courses.filter((c) => c.path_id === p.id);
      return `
      <section class="edit-path">
        <div class="edit-head">
          <h2><a href="#/manage/path/${p.id}">${esc(p.title)}</a></h2>
          <span class="edit-actions">
            <button type="button" class="icon-btn" data-move="paths:${p.id}:-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>&#8593;</button>
            <button type="button" class="icon-btn" data-move="paths:${p.id}:1" aria-label="Move down" ${i === list.length - 1 ? "disabled" : ""}>&#8595;</button>
            <a class="btn btn-ghost btn-sm" href="#/manage/path/${p.id}">Edit path</a>
            <a class="btn btn-primary btn-sm" href="#/manage/course/new?path=${p.id}">Add course</a>
          </span>
        </div>
        ${cs.length ? cs.map(courseBlock).join("") : `<p class="muted small edit-empty">No courses in this path yet.</p>`}
      </section>`;
    };

    return {
      html: `<section class="page-title">
        <div class="page-head"><h1>Content</h1>
          <a class="btn btn-primary" href="#/manage/path/new">Add learning path</a></div>
        <p class="muted">Learning paths hold courses; courses hold lessons in order. Use the arrows to reorder. Changes go live as soon as you save.</p>
        ${paths.length ? paths.map(pathBlock).join("") : `<div class="empty">No content yet. Start by adding a learning path.</div>`}
      </section>`,
      bind() {
        app.querySelector(".page-title").addEventListener("click", async (e) => {
          const b = e.target.closest("[data-move]");
          if (!b || b.disabled) return;
          const [table, id, dir] = b.dataset.move.split(":");
          const list = table === "paths" ? paths : table === "courses"
            ? courses.filter((c) => c.path_id === courses.find((x) => x.id === Number(id)).path_id)
            : lessonsOf(lessons.find((l) => l.id === Number(id)).course_id);
          const i = list.findIndex((x) => x.id === Number(id));
          try { await moveRow(table, list, i, Number(dir)); render(); }
          catch (err) { toast(err.message); }
        });
      },
    };
  }

  function editShell({ crumb, title, fields, isNew, deleteLabel, aside = "" }) {
    return `
      <section class="pad edit-page">
        <p class="crumb"><a href="#/manage">Content</a> / ${crumb}</p>
        <h1>${title}</h1>
        <form id="editform" class="form edit-form" novalidate>
          ${fields}
          <p class="form-error" id="formerr" role="alert" hidden></p>
          <div class="row edit-buttons">
            <button class="btn btn-primary" type="submit">${isNew ? "Create" : "Save changes"}</button>
            <a class="btn btn-ghost" href="#/manage">Cancel</a>
            ${!isNew ? `<button class="btn btn-danger" type="button" id="delete">${deleteLabel}</button>` : ""}
          </div>
        </form>
        ${aside}
      </section>`;
  }
  const textarea = (id, label, value, rows = 3, extra = "") =>
    `<label for="${id}">${label}</label><textarea id="${id}" name="${id}" rows="${rows}" ${extra}>${esc(value)}</textarea>`;
  const input = (id, label, value, type = "text", extra = "") =>
    `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${extra}>`;

  function bindDelete(label, fn) {
    const b = document.getElementById("delete");
    if (!b) return;
    b.addEventListener("click", async () => {
      if (!window.confirm(label)) return;
      b.disabled = true;
      try { await fn(); toast("Deleted"); go("#/manage"); }
      catch (err) { toast(err.message); b.disabled = false; }
    });
  }

  function parseSub(param) {
    const [kind, rest = ""] = param.split("/");
    const [idPart, qs = ""] = rest.split("?");
    return { kind, id: idPart === "new" ? null : Number(idPart) || null, isNew: idPart === "new", q: new URLSearchParams(qs) };
  }

  async function viewManagePath(sub) {
    if (!profile?.is_admin) return adminOnly();
    await loadCatalog();
    const row = sub.isNew ? { title: "", slug: "", description: "", sort: catalog.paths.length + 1 } : catalog.paths.find((p) => p.id === sub.id);
    if (!row) return notFound("learning path");
    return {
      html: editShell({ crumb: sub.isNew ? "New learning path" : esc(row.title), title: sub.isNew ? "New learning path" : "Edit learning path", isNew: sub.isNew, deleteLabel: "Delete path",
        fields: input("title", "Title", row.title, "text", "required") +
                input("slug", "Link name (letters, numbers, and dashes)", row.slug, "text", 'required pattern="[a-z0-9-]+"') +
                textarea("description", "Description (shown under the path title)", row.description) }),
      bind() {
        bindSlug();
        bindEditForm(async (v) => {
          if (!v.title.trim()) throw new Error("Enter a title.");
          await saveRow("paths", sub.id, { title: v.title.trim(), slug: slugify(v.slug) || slugify(v.title), description: v.description.trim(), sort: row.sort });
          toast(sub.isNew ? "Path created" : "Saved"); go("#/manage");
        });
        bindDelete(`Delete "${row.title}" and every course and lesson inside it? Learner progress in those courses is removed too. This cannot be undone.`, () => deleteRow("paths", sub.id));
      },
    };
  }

  async function viewManageCourse(sub) {
    if (!profile?.is_admin) return adminOnly();
    await loadCatalog();
    if (!catalog.paths.length) return { html: `<section class="narrow pad"><h1>Add a learning path first</h1><p>Courses live inside learning paths. <a href="#/manage/path/new">Create one</a>, then come back.</p></section>` };
    const defaultPath = Number(sub.q.get("path")) || catalog.paths[0].id;
    const row = sub.isNew
      ? { title: "", slug: "", description: "", image_url: "", path_id: defaultPath, sort: catalog.courses.filter((c) => c.path_id === defaultPath).length + 1 }
      : catalog.courses.find((c) => c.id === sub.id);
    if (!row) return notFound("course");
    const pathSelect = `<label for="path_id">Learning path</label><select id="path_id" name="path_id">
      ${catalog.paths.map((p) => `<option value="${p.id}" ${p.id === row.path_id ? "selected" : ""}>${esc(p.title)}</option>`).join("")}</select>`;
    return {
      html: editShell({ crumb: sub.isNew ? "New course" : esc(row.title), title: sub.isNew ? "New course" : "Edit course", isNew: sub.isNew, deleteLabel: "Delete course",
        fields: pathSelect +
                input("title", "Title", row.title, "text", "required") +
                input("slug", "Link name (letters, numbers, and dashes)", row.slug, "text", 'required pattern="[a-z0-9-]+"') +
                textarea("description", "Description (shown on the course card)", row.description) +
                input("image_url", "Thumbnail image link (optional, https://…)", row.image_url || "", "url") }),
      bind() {
        bindSlug();
        bindEditForm(async (v) => {
          if (!v.title.trim()) throw new Error("Enter a title.");
          await saveRow("courses", sub.id, { path_id: Number(v.path_id), title: v.title.trim(), slug: slugify(v.slug) || slugify(v.title),
            description: v.description.trim(), image_url: v.image_url.trim() || null, sort: row.sort });
          toast(sub.isNew ? "Course created" : "Saved"); go("#/manage");
        });
        bindDelete(`Delete "${row.title}" and all of its lessons? Learner progress and certificates for this course are removed too. This cannot be undone.`, () => deleteRow("courses", sub.id));
      },
    };
  }

  async function viewManageLesson(sub) {
    if (!profile?.is_admin) return adminOnly();
    await loadCatalog();
    if (!catalog.courses.length) return { html: `<section class="narrow pad"><h1>Add a course first</h1><p>Lessons live inside courses. <a href="#/manage/course/new">Create one</a>, then come back.</p></section>` };
    let row;
    if (sub.isNew) {
      const courseId = Number(sub.q.get("course")) || catalog.courses[0].id;
      row = { course_id: courseId, title: "", slug: "", kind: "video", video_url: "", body: "", minutes: 5, sort: lessonsOf(courseId).length + 1 };
    } else {
      const { data, error } = await sb.from("lessons").select("*").eq("id", sub.id).maybeSingle();
      if (error) throw error;
      row = data;
    }
    if (!row) return notFound("lesson");
    const courseSelect = `<label for="course_id">Course</label><select id="course_id" name="course_id">
      ${catalog.courses.map((c) => `<option value="${c.id}" ${c.id === row.course_id ? "selected" : ""}>${esc(c.title)}</option>`).join("")}</select>`;
    const kindSelect = `<label for="kind">Lesson type</label><select id="kind" name="kind">
      <option value="video" ${row.kind === "video" ? "selected" : ""}>Video lesson</option>
      <option value="guide" ${row.kind === "guide" ? "selected" : ""}>Troubleshooting guide</option></select>`;
    return {
      html: editShell({ crumb: sub.isNew ? "New lesson" : esc(row.title), title: sub.isNew ? "New lesson" : "Edit lesson", isNew: sub.isNew, deleteLabel: "Delete lesson",
        fields: `
          <div class="edit-grid">
            <div>${courseSelect}</div>
            <div>${kindSelect}</div>
          </div>
          ${input("title", "Title", row.title, "text", "required")}
          <div class="edit-grid">
            <div>${input("slug", "Link name (letters, numbers, and dashes)", row.slug, "text", 'required pattern="[a-z0-9-]+"')}</div>
            <div>${input("minutes", "Length in minutes", row.minutes, "number", 'min="1" max="600" required')}</div>
          </div>
          <div id="videofield" ${row.kind === "video" ? "" : "hidden"}>${input("video_url", "Video link (YouTube link, or a direct .mp4 link)", row.video_url || "", "url")}</div>
          <div class="md-editor">
            <div>
              ${textarea("body", "Lesson text (Markdown: # heading, **bold**, - list, | table |)", row.body, 18, 'spellcheck="true"')}
            </div>
            <div class="md-preview">
              <span class="md-preview-label">Preview</span>
              <div class="prose" id="preview"></div>
            </div>
          </div>`,
      }),
      bind() {
        bindSlug();
        const kind = document.getElementById("kind"), vf = document.getElementById("videofield");
        kind.addEventListener("change", () => { vf.hidden = kind.value !== "video"; });
        const body = document.getElementById("body"), prev = document.getElementById("preview");
        const paint = () => { prev.innerHTML = body.value.trim() ? md(body.value) : `<p class="muted">Start typing on the left to see the lesson here.</p>`; };
        body.addEventListener("input", paint); paint();
        bindEditForm(async (v) => {
          if (!v.title.trim()) throw new Error("Enter a title.");
          if (v.kind === "video" && !v.video_url.trim()) throw new Error("Add a video link, or change the lesson type to a guide.");
          const id = await saveRow("lessons", sub.id, {
            course_id: Number(v.course_id), title: v.title.trim(), slug: slugify(v.slug) || slugify(v.title), kind: v.kind,
            video_url: v.kind === "video" ? v.video_url.trim() : null, body: v.body, minutes: Math.max(1, Number(v.minutes) || 5), sort: row.sort,
          });
          toast(sub.isNew ? "Lesson created" : "Saved");
          go(sub.isNew ? `#/manage/lesson/${id}` : "#/manage");
        });
        bindDelete(`Delete "${row.title}"? Learners who completed it lose that progress. This cannot be undone.`, () => deleteRow("lessons", sub.id));
      },
    };
  }

  function notFound(what) {
    return { html: `<section class="narrow pad"><h1>That ${what} does not exist</h1><p>The link may be out of date. <a href="#/learn">Go to your courses</a>.</p></section>` };
  }

  // ---------- router ----------
  const PUBLIC = new Set(["", "login", "signup", "reset", "new-password", "verify"]);

  async function render() {
    const token = ++renderToken;
    const r = parseRoute();
    renderTopbar();

    if (!configured) { app.innerHTML = `<div class="wrap">${viewSetup().html}</div>`; return; }

    // The gate: anything that is not public sends visitors to sign-up and remembers where they were going.
    if (!PUBLIC.has(r.name) && !session) {
      try { localStorage.setItem(RETURN_KEY, location.hash); } catch (_) {}
      go("#/signup");
      return;
    }
    if (session && ["", "login", "signup"].includes(r.name)) { goAfterAuth(); return; }

    try {
      let v;
      switch (r.name) {
        case "": v = viewHome(); break;
        case "signup": v = viewSignup(); break;
        case "login": v = viewLogin(); break;
        case "reset": v = viewReset(); break;
        case "new-password": v = viewNewPassword(); break;
        case "verify": v = await viewVerify(r.param); break;
        case "learn": v = await viewLearn(); break;
        case "course": v = await viewCourse(r.param); break;
        case "lesson": v = await viewLesson(r.param); break;
        case "guides": v = await viewGuides(); break;
        case "videos": v = await viewVideos(); break;
        case "certificates": v = await viewCertificates(); break;
        case "admin": v = await viewAdmin(); break;
        case "manage": {
          const sub = parseSub(r.param);
          v = sub.kind === "path" ? await viewManagePath(sub)
            : sub.kind === "course" ? await viewManageCourse(sub)
            : sub.kind === "lesson" ? await viewManageLesson(sub)
            : await viewManage();
          break;
        }
        default: v = notFound("page");
      }
      if (token !== renderToken) return;   // a newer navigation won
      app.innerHTML = v.full ? v.html : `<div class="wrap">${v.html}</div>`;
      if (v.bind) v.bind();
      flash = "";
      document.title = (app.querySelector("h1")?.textContent || SITE) + " | " + SITE;
      window.scrollTo(0, 0);
    } catch (err) {
      console.error(err);
      if (token !== renderToken) return;
      app.innerHTML = `<div class="wrap"><section class="narrow pad"><h1>This page could not load</h1>
        <p>${esc(err.message || "Unknown error")}</p>
        <p class="muted">If this is a new setup, check that <code>supabase/schema.sql</code> ran without errors and that the keys in <code>js/config.js</code> are correct.</p></section></div>`;
    }
  }

  async function start() {
    document.title = SITE;
    renderUtility();
    if (!configured) { render(); return; }

    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    sb.auth.onAuthStateChange((event, s) => {
      const hadSession = !!session;
      session = s;
      // Never call Supabase from inside this callback; defer instead.
      if (event === "SIGNED_OUT" && hadSession) setTimeout(() => { profile = null; catalog = null; go("#/"); }, 0);
    });

    const { data } = await sb.auth.getSession();   // also finishes handling email-link tokens in the URL
    session = data.session;
    // "Remember me" unchecked: the session lasts until the browser or tab is closed.
    let forget = false;
    try { forget = session && localStorage.getItem(REMEMBER_KEY) === "0" && !sessionStorage.getItem(TAB_KEY) && !cameFromRecovery; } catch (_) {}
    if (forget) { await sb.auth.signOut(); session = null; }
    try { if (session) sessionStorage.setItem(TAB_KEY, "1"); } catch (_) {}
    if (session) await loadProfile();

    window.addEventListener("hashchange", render);

    if (cameFromRecovery && session) { go("#/new-password"); return; }
    if (!location.hash.startsWith("#/")) {
      if (session) { goAfterAuth(); return; }
      if (flash) { go("#/login"); return; }
      history.replaceState(null, "", BASE_URL + "#/");
    }
    render();
  }

  start();
})();

