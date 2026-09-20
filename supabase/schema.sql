-- Fieldbook Training: database setup
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.
-- It is safe to run more than once.

-- ---------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.paths (
  id bigint generated always as identity primary key,
  slug text unique not null,
  title text not null,
  description text not null default '',
  sort int not null default 0
);

create table if not exists public.courses (
  id bigint generated always as identity primary key,
  path_id bigint not null references public.paths (id) on delete cascade,
  slug text unique not null,
  title text not null,
  description text not null default '',
  sort int not null default 0
);

-- Optional thumbnail shown on the course card (a full https:// image URL). Safe to run again.
alter table public.courses add column if not exists image_url text;

create table if not exists public.lessons (
  id bigint generated always as identity primary key,
  course_id bigint not null references public.courses (id) on delete cascade,
  slug text unique not null,
  title text not null,
  kind text not null default 'guide' check (kind in ('video', 'guide')),
  video_url text,                       -- YouTube link or a direct .mp4 link
  body text not null default '',        -- Markdown
  minutes int not null default 5,
  sort int not null default 0
);

create table if not exists public.lesson_completions (
  user_id uuid not null references auth.users (id) on delete cascade,
  lesson_id bigint not null references public.lessons (id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id bigint not null references public.courses (id) on delete cascade,
  issued_at timestamptz not null default now(),
  unique (user_id, course_id)
);

-- ---------------------------------------------------------------
-- A profile row is created automatically for every new account
-- ---------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------
-- Access rules. This is the real gate: without an account,
-- the database returns no lesson content at all.
-- ---------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.paths enable row level security;
alter table public.courses enable row level security;
alter table public.lessons enable row level security;
alter table public.lesson_completions enable row level security;
alter table public.certificates enable row level security;

drop policy if exists "profiles: read own or admin" on public.profiles;
create policy "profiles: read own or admin" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Learners can change their name but can never make themselves an admin.
revoke update on public.profiles from anon, authenticated;
grant update (full_name) on public.profiles to authenticated;

drop policy if exists "paths: members read" on public.paths;
create policy "paths: members read" on public.paths for select to authenticated using (true);
drop policy if exists "paths: admin write" on public.paths;
create policy "paths: admin write" on public.paths for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "courses: members read" on public.courses;
create policy "courses: members read" on public.courses for select to authenticated using (true);
drop policy if exists "courses: admin write" on public.courses;
create policy "courses: admin write" on public.courses for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "lessons: members read" on public.lessons;
create policy "lessons: members read" on public.lessons for select to authenticated using (true);
drop policy if exists "lessons: admin write" on public.lessons;
create policy "lessons: admin write" on public.lessons for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "completions: read own or admin" on public.lesson_completions;
create policy "completions: read own or admin" on public.lesson_completions
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "completions: add own" on public.lesson_completions;
create policy "completions: add own" on public.lesson_completions
  for insert to authenticated with check (user_id = auth.uid());

-- Certificates can be read, but only issued through issue_certificate() below.
drop policy if exists "certificates: read own or admin" on public.certificates;
create policy "certificates: read own or admin" on public.certificates
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------
-- Certificates: issued by the database only when every lesson is done
-- ---------------------------------------------------------------
create or replace function public.issue_certificate(p_course_id bigint)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_total int;
  v_done int;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;

  select count(*) into v_total from lessons l where l.course_id = p_course_id;
  select count(*) into v_done
    from lesson_completions lc
    join lessons l on l.id = lc.lesson_id
   where l.course_id = p_course_id and lc.user_id = auth.uid();

  if v_total = 0 or v_done < v_total then
    raise exception 'Course is not complete yet';
  end if;

  insert into certificates (user_id, course_id)
  values (auth.uid(), p_course_id)
  on conflict (user_id, course_id) do nothing;

  select c.id into v_id from certificates c
   where c.user_id = auth.uid() and c.course_id = p_course_id;
  return v_id;
end $$;

-- Anyone with a certificate ID can check that it is real (no account needed).
create or replace function public.verify_certificate(p_id uuid)
returns table (full_name text, course_title text, issued_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.full_name, c.title, cert.issued_at
    from certificates cert
    join profiles p on p.id = cert.user_id
    join courses c on c.id = cert.course_id
   where cert.id = p_id;
$$;

-- ---------------------------------------------------------------
-- Admin report: who has done what
-- ---------------------------------------------------------------
create or replace function public.admin_progress()
returns table (
  learner_id uuid,
  full_name text,
  email text,
  course_title text,
  lessons_done int,
  lessons_total int,
  last_activity timestamptz,
  certificate_id uuid,
  certified_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  return query
  select p.id,
         p.full_name,
         p.email,
         c.title,
         count(lc.lesson_id)::int,
         (select count(*)::int from lessons l2 where l2.course_id = c.id),
         max(lc.completed_at),
         cert.id,
         cert.issued_at
    from lesson_completions lc
    join lessons l on l.id = lc.lesson_id
    join courses c on c.id = l.course_id
    join profiles p on p.id = lc.user_id
    left join certificates cert on cert.user_id = p.id and cert.course_id = c.id
   group by p.id, p.full_name, p.email, c.id, c.title, cert.id, cert.issued_at
   order by max(lc.completed_at) desc;
end $$;

revoke execute on function public.issue_certificate(bigint) from public, anon;
revoke execute on function public.admin_progress() from public, anon;
grant execute on function public.issue_certificate(bigint) to authenticated;
grant execute on function public.admin_progress() to authenticated;
grant execute on function public.verify_certificate(uuid) to anon, authenticated;

-- ---------------------------------------------------------------
-- Sample content (replace with your own in Table Editor)
-- ---------------------------------------------------------------
insert into public.paths (slug, title, description, sort) values
  ('network-support', 'Network support technician',
   'Start here if you install or support customer networks. Two short courses take you from how a device gets online to fixing the most common Wi-Fi complaints.', 1)
on conflict (slug) do nothing;

insert into public.courses (path_id, slug, title, description, sort) values
  ((select id from public.paths where slug = 'network-support'), 'network-fundamentals', 'Network troubleshooting fundamentals',
   'How a device gets online, what the lights are telling you, and a repeatable way to find the fault.', 1),
  ((select id from public.paths where slug = 'network-support'), 'wifi-troubleshooting', 'Wi-Fi troubleshooting',
   'Slow, dropping, or missing Wi-Fi: how to tell a signal problem from an internet problem.', 2)
on conflict (slug) do nothing;

insert into public.lessons (course_id, slug, title, kind, video_url, body, minutes, sort) values
((select id from public.courses where slug = 'network-fundamentals'), 'how-a-device-gets-online',
 'How a device gets online', 'video', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
$md$
*The video above is a placeholder. Put your own YouTube link (unlisted works well) or an .mp4 link in the `video_url` column.*

## What to take from this lesson

Every connection problem sits on one of four links in a chain. If you know the chain, you know where to look.

1. **Physical link.** The cable or Wi-Fi signal between the device and the router.
2. **Local address.** The router hands the device an IP address using DHCP.
3. **Route out.** The router forwards traffic to the internet provider.
4. **Names.** DNS turns a name like `example.com` into an address.

Work the chain in order. A fault early in the chain makes everything after it look broken too.
$md$, 8, 1),

((select id from public.courses where slug = 'network-fundamentals'), 'reading-link-lights',
 'Reading link lights and checking cables', 'guide', null,
$md$
## What the lights mean

| Light | State | Meaning |
|---|---|---|
| Link | Off | No physical connection. Check the cable and the port. |
| Link | Solid | Connected, no traffic right now. |
| Link | Blinking | Connected and passing traffic. |
| Speed | Amber (on many devices) | Connected at a lower speed than the port supports. |

Colours vary by manufacturer, so confirm against the label or manual for the device in front of you.

## Cable checks

- Reseat both ends until you hear the click.
- Look for a broken latch tab. A plug without a tab will work loose.
- Swap in a known-good cable before replacing any hardware.
- Try a different port on the router or switch.
$md$, 6, 2),

((select id from public.courses where slug = 'network-fundamentals'), 'guide-no-internet',
 'Troubleshooting guide: no internet connection', 'guide', null,
$md$
Use this guide on site. Work from the top and stop at the first step that fails.

## 1. Is it one device or every device?

- **One device:** the fault is on that device or its link. Go to step 2.
- **Every device:** the fault is the router or the provider. Go to step 4.

## 2. Check the link

Wired: is the link light on? Wireless: is the device joined to the right network with a usable signal?

## 3. Check the address

Open the network settings and look at the IP address.

- An address starting `169.254.` means the device never got an address from the router. Restart the device's network connection, then the router.
- A normal private address (for example `192.168.x.x`) means the local link is fine. Continue.

## 4. Check the route out

From a computer, run:

```
ping 8.8.8.8
```

- **Replies:** the internet connection works. The fault is DNS. Go to step 5.
- **No replies:** restart the modem and router, modem first. If it is still down, check for a provider outage.

## 5. Check names

```
ping example.com
```

If step 4 worked but this fails, DNS is the problem. Restart the router, or set the device's DNS server to a public one to confirm.
$md$, 10, 3),

((select id from public.courses where slug = 'network-fundamentals'), 'ping-and-traceroute',
 'Using ping and traceroute', 'video', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
$md$
*Placeholder video. Replace the link in `video_url`.*

## Quick reference

- `ping <address>` tells you whether a device answers and how long it takes.
- `tracert <address>` on Windows, or `traceroute <address>` on macOS and Linux, shows each hop on the way, so you can see where traffic stops.

Ping the router first, then a public address, then a name. The first one that fails points at the broken link in the chain.
$md$, 7, 4),

((select id from public.courses where slug = 'wifi-troubleshooting'), 'signal-vs-internet',
 'Signal problem or internet problem?', 'video', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
$md$
*Placeholder video. Replace the link in `video_url`.*

## The one test that splits the problem

Plug a laptop into the router with a cable and run a speed test.

- **Wired is fast, Wi-Fi is slow:** it is a Wi-Fi problem. Look at signal strength, interference, and router placement.
- **Wired is slow too:** it is not Wi-Fi. Look at the modem, the router, or the provider.
$md$, 6, 1),

((select id from public.courses where slug = 'wifi-troubleshooting'), 'guide-slow-wifi',
 'Troubleshooting guide: slow or dropping Wi-Fi', 'guide', null,
$md$
## 1. Where does it happen?

- **Everywhere:** restart the router, then run the wired test from the previous lesson.
- **Only in some rooms:** it is coverage. Go to step 2.

## 2. Check placement

- Router in the open, off the floor, away from large metal objects.
- As central to the building as the cabling allows.

## 3. Check the band

- 2.4 GHz reaches further and is slower and more crowded.
- 5 GHz is faster and has shorter range.

A device far from the router on 5 GHz may do better on 2.4 GHz, and the reverse up close.

## 4. Check for crowding

In apartments and offices, neighbouring networks share the same channels. Let the router pick its channel automatically, or choose the least used one with a Wi-Fi analyser app.

## 5. Still dropping?

Note the time, the device, and the room, then escalate with those details.
$md$, 9, 2)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------
-- After you create your own account on the site, make yourself an admin:
--   update public.profiles set is_admin = true where email = 'you@example.com';
-- ---------------------------------------------------------------
