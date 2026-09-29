# Fieldbook Training

A training site with accounts, learning paths, video lessons, troubleshooting guides, certificates, and an admin report of who has completed what. It runs free on GitHub Pages plus a free Supabase project. There is no build step: plain HTML, CSS, and JavaScript.

"Fieldbook Training" and the networking lessons are sample content. Change the name in `js/config.js`, `index.html`, and `manifest.webmanifest`, and replace the lessons in Supabase.

## What is in the repo

| File | Purpose |
|---|---|
| `index.html` | The single page that loads everything |
| `js/config.js` | Site name, Supabase keys, utility-bar links, landing-page text, and page size. The only file you must edit |
| `js/app.js` | Sign-up, sign-in, pages, progress, certificates, admin report |
| `css/styles.css` | All styling |
| `supabase/schema.sql` | Database tables, access rules, and sample content |
| `manifest.webmanifest`, `icon.svg` | Lets people add the site to a phone home screen |

## Pages

| Page | What it shows |
|---|---|
| Landing / Sign in | Banner text (set in `js/config.js`) with the sign-in card beside it |
| Courses | Card grid of every course, filter chips per learning path, search, and pagination |
| Video Library | Every video lesson as a card with its thumbnail |
| Resource Library | Every troubleshooting guide as a card, searchable by symptom or part |
| Learning path ladder | Paths are a ladder in the order shown on the Content page. The starting survey places each learner on a rung; every path below it is waived (its courses count as done and its master exam is open straight away). Within a path, courses unlock in order: each opens when the previous one is complete (lessons done and quiz passed). The home screen shows progress in the learner's current path |
| Quizzes | Each course can have an end-of-course quiz that unlocks when every lesson is done. Six question types: multiple choice, true/false, select all that apply, slider (exact value or range), pin on a picture, and put in order. Each question can link a troubleshooting guide for help. Grading happens in the database, so answer keys never reach the browser. Passing it marks the course complete and unlocks the next course |
| Master exams | Each learning path can have a master exam that unlocks once every course in the path is complete (or the path is waived). Passing it issues the learning path certificate, the only kind of certificate |
| Certificates | Learning path certificates, with verification links |
| Learners (admins) | Searchable, paged list of every learner: lessons done, quizzes passed, exams passed, average quiz and exam scores, last activity, role. Click one for course progress, quiz attempts, and survey answers, and to grant or remove admin access. CSV export of all progress |
| Starting survey | New learners answer a short survey after signing up. Admins write the questions under Content → Starting survey and tick which learning paths each answer points at; the learner's Courses page then puts the best-matching path first, marked "Recommended for you" |
| Content (admins) | Add, edit, reorder, and delete learning paths, courses, and lessons without opening Supabase. Video lessons use Markdown with a live preview; troubleshooting guides are a title, a description, and a PDF upload |

**Resource Library groups.** Admins create groups under Content → Guide groups (name, search keywords, thumbnail picture) and put a guide in a group from the guide editor. The library shows group tiles and ungrouped guides; a search shows the groups whose guides match plus matching ungrouped guides. PDF guides get a first-page thumbnail made automatically at upload.

PDF guides are stored in a private Supabase Storage bucket called `guides` (created by `schema.sql`). Learners read them on the page through a viewer with no download button, and the link to the file expires after an hour. The text inside each PDF is extracted on upload so the Resource Library search finds it. Scanned PDFs with no text layer still work, they just match on title and description only.

Admins see **Learners** and **Content** in the header. The first admin is created with the SQL line at the bottom of `schema.sql`; after that, admins promote others from the Learners page. The database will not let an admin demote themselves or remove the last admin. Everything under Content saves straight to Supabase and is live for learners immediately. Deleting a course or path also deletes its lessons and learner progress, so the site asks you to confirm first. Course thumbnails are set in the course editor (an https:// image link); cards without one show a plain navy tile.

## Setup (about 15 minutes)

### 1. Create the database

1. Sign up at [supabase.com](https://supabase.com) and create a new project. Save the database password somewhere.
2. Open **SQL Editor**, choose **New query**, paste in all of `supabase/schema.sql`, and press **Run**. You should see "Success". The file is safe to run again later.
3. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key into `js/config.js`.

The anon key is designed to be public. It only allows what the rules in `schema.sql` allow, which for a visitor without an account is nothing except checking a certificate ID.

### 2. Put the site on GitHub Pages

1. Create a repository and push these files to the `main` branch.
2. In the repository: **Settings > Pages > Build and deployment**. Source: **Deploy from a branch**. Branch: `main`, folder `/ (root)`. Save.
3. After a minute the site is live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

Free GitHub Pages needs a public repository. If you want the code private, connect the same repository to Cloudflare Pages or Netlify instead. Both have free plans, and no code changes are needed.

### 3. Tell Supabase where the site lives

In Supabase: **Authentication > URL Configuration**.

- **Site URL**: your Pages address, including the trailing slash.
- **Redirect URLs**: add the same address. Add `http://localhost:8000/` too if you test locally.

Without this step, the links in confirmation and password-reset emails point to the wrong place.

**For a demo, consider turning off email confirmation.** Under **Authentication > Sign In / Providers > Email**, switch off "Confirm email". People are then signed in the moment they create an account. Supabase's built-in email sender only allows a handful of emails per hour, which is easy to hit while showing the site to a group. Before a real launch, turn confirmation back on and connect your own email sender under the SMTP settings.

### 4. Make yourself an admin

1. Open your site and create an account the normal way.
2. In Supabase **SQL Editor**, run:

```sql
update public.profiles set is_admin = true where email = 'you@example.com';
```

3. Reload the site. An **Admin** link appears in the top bar.

Admin access can only be granted from the Supabase dashboard. Nobody can grant it to themselves from the site.

### Test locally (optional)

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## How the pieces work

**The account gate.** Every page except the home page, the sign-in pages, and the certificate check requires an account. If someone opens a shared link such as `.../#/lesson/guide-no-internet` without being signed in, the site remembers where they were going, sends them to create an account, and then takes them straight to that lesson.

The gate is enforced in the database, not only on the page. Lesson content is stored in Supabase, and the rules in `schema.sql` return nothing to anyone who is not signed in. That matters because everything in a public repository is readable by anyone. **Keep lesson content in Supabase, never in this repo.**

**Sharing.** Course and lesson pages have a Share button. On a phone it opens the share sheet. On a computer it copies the link.

**Progress and certificates.** Learners press "Mark lesson complete". When every lesson in a course is complete, the database issues a certificate. The database checks completion itself, so a certificate cannot be faked from the browser. The PDF is generated in the browser and carries an ID and a link. Anyone can open that link to confirm the certificate is real, without an account.

**Admin report.** The Admin page lists each learner, each course they have started, lessons done, last activity, and completion date. It can be filtered by learner, course, and status, and downloaded as CSV. You can also open the `lesson_completions` and `certificates` tables directly in Supabase.

## Adding your own content

For now, content is edited in Supabase **Table Editor**. No code changes or redeploys are needed, and changes appear on the site straight away.

- `paths`: a learning path. `sort` controls the order.
- `courses`: belongs to a path through `path_id`.
- `lessons`: belongs to a course through `course_id`.
  - `slug` is the link name and must be unique, for example `replacing-a-filter`.
  - `kind` is `video` or `guide`. Every guide appears in the searchable Guides library as well as in its course.
  - `video_url` takes a YouTube link or a direct `.mp4` link.
  - `body` is written in Markdown: headings, lists, tables, code blocks, links.
  - `minutes` is the estimated time, and `sort` is the order within the course.

The sample lessons all use one placeholder video. Replace those links with your own.

## Limits of the free setup

- **Videos are not truly private.** An unlisted YouTube video can be watched by anyone who gets hold of its link. The page around it is gated, but the video file is not. When that matters, move to a paid video host that supports signed links (Cloudflare Stream, Mux, Vimeo, or Supabase Storage with private buckets).
- **Supabase free projects pause** after a period with no activity. Visit the dashboard to wake one up. Check Supabase's pricing page for current limits on users, storage, and email.
- **Completion is self-reported.** Learners press a button. Quizzes or watch-time tracking are the next step if you need proof of attention.

## Where this can go next

1. An in-site editor so admins can add lessons without opening Supabase.
2. Quizzes with a pass mark before a lesson counts as complete.
3. Teams or companies, so a manager sees only their own people.
4. A phone app. The site already works as a home-screen app. For the app stores, wrap this same code with [Capacitor](https://capacitorjs.com) and keep the same Supabase project, so accounts and progress carry over.
5. Paid video hosting and a paid Supabase plan once real learners depend on it.
