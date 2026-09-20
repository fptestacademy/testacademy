/* Fieldbook Training. Plain JavaScript, no build step.
   Pages are hash routes (#/learn, #/lesson/slug) so the site works on any static host. */
(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const app = document.getElementById("app");
  const topbar = document.getElementById("topbar");
  const SITE = cfg.SITE_NAME || "Training";
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
      sb.from("lessons").select("id,course_id,slug,title,kind,minutes,sort").order("sort"),
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

  // ---------- header ----------
  function renderTopbar() {
    const r = parseRoute().name;
    const cur = (n) => (r === n ? ' aria-current="page"' : "");
    let nav = "";
    if (session) {
      nav = `
        <nav class="nav" aria-label="Main">
          <a href="#/learn"${cur("learn")}>Learn</a>
          <a href="#/guides"${cur("guides")}>Guides</a>
          <a href="#/certificates"${cur("certificates")}>Certificates</a>
          ${profile?.is_admin ? `<a href="#/admin"${cur("admin")}>Admin</a>` : ""}
        </nav>
        <div class="who">
          <span class="who-name">${esc(profile?.full_name || session.user.email)}</span>
          <button class="btn btn-ghost-light" id="signout" type="button">Sign out</button>
        </div>`;
    } else if (configured) {
      nav = `<div class="who">
          <a class="btn btn-ghost-light" href="#/login">Sign in</a>
          <a class="btn btn-accent" href="#/signup">Create account</a>
        </div>`;
    }
    topbar.innerHTML = `<a class="brand" href="#/${session ? "learn" : ""}">
        <img src="icon.svg" alt="" width="28" height="28"><span>${esc(SITE)}</span></a>${nav}`;
    const so = document.getElementById("signout");
    if (so) so.addEventListener("click", async () => {
      await sb.auth.signOut();
      session = null; profile = null; catalog = null;
      go("#/");
    });
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

  function viewHome() {
    const stops = [
      ["done", "Video", "How a device gets online"],
      ["done", "Guide", "Reading link lights and checking cables"],
      ["now", "Guide", "Troubleshooting guide: no internet connection"],
      ["", "Video", "Using ping and traceroute"],
      ["cert", "", "Certificate when every lesson is done"],
    ];
    return { html: `
      <section class="hero">
        <div class="hero-copy">
          <h1>Learn the job one lesson at a time. Keep the guides for when things break.</h1>
          <p class="lede">Short video lessons in a set order, troubleshooting guides you can pull up on site, and a certificate when you finish a course.</p>
          <div class="row">
            <a class="btn btn-primary" href="#/signup">Create free account</a>
            <a class="btn btn-ghost" href="#/login">Sign in</a>
          </div>
        </div>
        <div class="hero-rail" aria-hidden="true">
          <p class="rail-title">Network troubleshooting fundamentals</p>
          <ol class="rail">
            ${stops.map(([s, k, t]) => `<li class="stop ${s}"><span class="dot"></span><div class="stop-body">${k ? `<span class="kind">${k}</span>` : ""}<span class="stop-title">${t}</span></div></li>`).join("")}
          </ol>
        </div>
      </section>
      <section class="three">
        <div><h2>Learning paths</h2><p>Courses are grouped into paths, and lessons run in order, so nobody has to guess what to study next. Progress is saved to your account.</p></div>
        <div><h2>Troubleshooting guides</h2><p>Every guide from every course sits in one searchable library. Written to be followed step by step with the equipment in front of you.</p></div>
        <div><h2>Certificates</h2><p>Finish every lesson in a course and download a certificate. Each one carries an ID that anyone can check on this site.</p></div>
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

  function viewSignup() {
    return {
      html: authShell("Create your account", flash || pendingNotice(),
        field("full_name", "Full name (printed on your certificates)", "text", 'autocomplete="name"') +
        field("email", "Email", "email", 'autocomplete="email"') +
        field("password", "Password (8 characters or more)", "password", 'autocomplete="new-password" minlength="8"'),
        "Create account", `Already have an account? <a href="#/login">Sign in</a>`),
      bind() {
        bindAuth(async ({ full_name, email, password }) => {
          if (!full_name.trim()) throw new Error("Enter your full name.");
          if (password.length < 8) throw new Error("Use a password with 8 characters or more.");
          // Put the page they were heading to inside the confirmation link, so it survives
          // the email being opened in a different browser, app, or device.
          let dest = "";
          try { dest = localStorage.getItem(RETURN_KEY) || ""; } catch (_) {}
          const redirect = dest.startsWith("#/") ? `${BASE_URL}?next=${encodeURIComponent(dest)}` : BASE_URL;
          const { data, error } = await sb.auth.signUp({
            email: email.trim(), password,
            options: { data: { full_name: full_name.trim() }, emailRedirectTo: redirect },
          });
          if (error) throw error;
          if (data.user && data.user.identities && data.user.identities.length === 0)
            throw new Error("An account with this email already exists. Sign in instead.");
          if (data.session) {
            session = data.session; await loadProfile(); goAfterAuth();
          } else {
            app.innerHTML = `<section class="narrow pad"><h1>Check your email</h1>
              <p>We sent a confirmation link to <strong>${esc(email)}</strong>. Open it and you will be signed in and taken to the page you wanted.</p></section>`;
          }
        });
      },
    };
  }

  function viewLogin() {
    return {
      html: authShell("Sign in", flash || pendingNotice(),
        field("email", "Email", "email", 'autocomplete="email"') +
        field("password", "Password", "password", 'autocomplete="current-password"'),
        "Sign in", `New here? <a href="#/signup">Create account</a><br><a href="#/reset">Forgot your password?</a>`),
      bind() {
        bindAuth(async ({ email, password }) => {
          const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
          if (error) throw new Error(error.message === "Invalid login credentials" ? "That email and password do not match an account." : error.message);
          session = data.session; await loadProfile(); goAfterAuth();
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
  async function viewLearn() {
    await loadCatalog();
    const done = await loadDone();
    if (!catalog.paths.length)
      return { html: `<section class="pad"><h1>No courses yet</h1><p>Add paths, courses, and lessons in the Supabase Table Editor, or run the sample content in <code>supabase/schema.sql</code>.</p></section>` };

    const open = catalog.courses.map((c) => ({ course: c, st: courseStats(c, done) })).filter((x) => !x.st.complete && x.st.next);
    const pick = open.find((x) => x.st.done > 0) || open[0];   // a course already started wins
    const upNext = pick ? { course: pick.course, lesson: pick.st.next, started: pick.st.done > 0 } : null;

    const first = (profile?.full_name || "").split(" ")[0];
    return { html: `
      <section class="pad">
        <h1>${first ? `Welcome back, ${esc(first)}` : "Your training"}</h1>
        ${upNext ? `<a class="upnext" href="#/lesson/${esc(upNext.lesson.slug)}">
            <span class="upnext-label">${upNext.started ? "Continue where you stopped" : "Start here"}</span>
            <span class="upnext-title">${esc(upNext.lesson.title)}</span>
            <span class="upnext-course">${esc(upNext.course.title)}</span></a>`
          : `<p class="notice">You have finished every course. Your certificates are on the <a href="#/certificates">certificates page</a>.</p>`}
        ${catalog.paths.map((p) => `
          <div class="path">
            <h2>${esc(p.title)}</h2>
            <p class="path-desc">${esc(p.description)}</p>
            <ol class="course-list">
              ${catalog.courses.filter((c) => c.path_id === p.id).map((c) => {
                const st = courseStats(c, done);
                const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
                const label = st.complete ? "Review course" : st.done ? "Continue course" : "Start course";
                return `<li class="course ${st.complete ? "is-complete" : ""}">
                  <div class="course-main">
                    <h3><a href="#/course/${esc(c.slug)}">${esc(c.title)}</a></h3>
                    <p>${esc(c.description)}</p>
                    <p class="muted small">${st.total} lessons, about ${st.minutes} minutes</p>
                  </div>
                  <div class="course-side">
                    <div class="bar" role="img" aria-label="${st.done} of ${st.total} lessons complete"><span style="width:${pct}%"></span></div>
                    <p class="small">${st.complete ? "Complete" : `${st.done} of ${st.total} lessons`}</p>
                    <a class="btn ${st.complete ? "btn-ghost" : "btn-primary"}" href="#/course/${esc(c.slug)}">${label}</a>
                  </div></li>`;
              }).join("")}
            </ol>
          </div>`).join("")}
      </section>` };
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
    const items = data.map((g) => ({ ...g, course: catalog.courses.find((c) => c.id === g.course_id)?.title || "",
      hay: (g.title + " " + g.body).toLowerCase() }));
    const list = (q) => {
      const hits = q ? items.filter((g) => q.split(/\s+/).every((w) => g.hay.includes(w))) : items;
      if (!hits.length) return `<p class="muted">No guide mentions “${esc(q)}”. Try a symptom or a part name, such as “no internet” or “cable”.</p>`;
      return `<ul class="guide-list">${hits.map((g) => `<li><a href="#/lesson/${esc(g.slug)}">${esc(g.title)}</a><span class="muted small">${esc(g.course)}</span></li>`).join("")}</ul>`;
    };
    return {
      html: `<section class="pad">
        <h1>Troubleshooting guides</h1>
        <label for="q" class="sr">Search guides</label>
        <input id="q" class="search" type="search" placeholder="Search by symptom, part, or error" autocomplete="off">
        <div id="guides">${list("")}</div></section>`,
      bind() {
        const q = document.getElementById("q");
        q.addEventListener("input", () => { document.getElementById("guides").innerHTML = list(q.value.trim().toLowerCase()); });
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
          <button class="btn btn-ghost" id="csv" type="button">Download CSV</button></div>
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

  function notFound(what) {
    return { html: `<section class="narrow pad"><h1>That ${what} does not exist</h1><p>The link may be out of date. <a href="#/learn">Go to your courses</a>.</p></section>` };
  }

  // ---------- router ----------
  const PUBLIC = new Set(["", "login", "signup", "reset", "new-password", "verify"]);

  async function render() {
    const token = ++renderToken;
    const r = parseRoute();
    renderTopbar();

    if (!configured) { app.innerHTML = viewSetup().html; return; }

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
        case "certificates": v = await viewCertificates(); break;
        case "admin": v = await viewAdmin(); break;
        default: v = notFound("page");
      }
      if (token !== renderToken) return;   // a newer navigation won
      app.innerHTML = v.html;
      if (v.bind) v.bind();
      flash = "";
      document.title = (app.querySelector("h1")?.textContent || SITE) + " | " + SITE;
      window.scrollTo(0, 0);
    } catch (err) {
      console.error(err);
      if (token !== renderToken) return;
      app.innerHTML = `<section class="narrow pad"><h1>This page could not load</h1>
        <p>${esc(err.message || "Unknown error")}</p>
        <p class="muted">If this is a new setup, check that <code>supabase/schema.sql</code> ran without errors and that the keys in <code>js/config.js</code> are correct.</p></section>`;
    }
  }

  async function start() {
    document.title = SITE;
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
    if (session) await loadProfile();

    // Coming back from a confirmation email: the destination rides along as ?next=#/lesson/...
    const next = new URLSearchParams(location.search).get("next");
    let cameWithNext = false;
    if (next && next.startsWith("#/")) {
      cameWithNext = true;
      try { localStorage.setItem(RETURN_KEY, next); } catch (_) {}
    }
    if (location.search) history.replaceState(null, "", BASE_URL + location.hash);   // tidy the address bar

    window.addEventListener("hashchange", render);

    if (cameFromRecovery && session) { go("#/new-password"); return; }
    if (!location.hash.startsWith("#/")) {
      if (session) { goAfterAuth(); return; }
      if (flash || cameWithNext) { go("#/login"); return; }   // confirmed but not signed in here: sign in, then continue
      history.replaceState(null, "", BASE_URL + "#/");
    }
    render();
  }

  start();
})();
