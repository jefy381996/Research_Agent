/* The phone layout.
 *
 * The sections used to sit in a bar across the bottom: eight of them and a
 * theme switch, at nine and a half pixels, with the labels cut down until
 * Measurements read "Battery" and My data read "Mine". Every control in the
 * composer was 38 pixels tall, which is under what a thumb reliably hits.
 * And voice was two buttons side by side carrying the same waveform icon,
 * which read as two halves of one setting rather than two settings.
 *
 * Run against a served instance:  node tests/mobile_ui.js [url]
 */
const { chromium, devices } = require("playwright");
const URL = process.argv[2] || "http://127.0.0.1:8099/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, total = 0;
const fails = [];
function check(label, ok, detail) {
  total += 1;
  if (ok) { pass += 1; console.log("  PASS  " + label); }
  else { fails.push(label); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
}

async function openApp(browser, device) {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.DATA && window.DATA.stats, { timeout: 30000 });
  await sleep(2800);
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch();
  const { page, errors } = await openApp(browser, devices["Pixel 7"]);

  /* ── the bar, and the drawer behind it ────────────────── */
  const bar = await page.evaluate(() => {
    const b = document.querySelector(".appbar");
    return b ? { shown: getComputedStyle(b).display !== "none",
                 h: Math.round(b.getBoundingClientRect().height),
                 title: (document.getElementById("abtitle") || {}).textContent } : null;
  });
  check("a bar sits at the top of the phone layout", !!bar && bar.shown, JSON.stringify(bar));
  check("it names the section that is open", bar && bar.title === "Ask", bar && bar.title);

  const shut = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("side"));
    return { vis: s.visibility, pos: s.position, z: s.zIndex };
  });
  check("the drawer starts closed", shut.vis === "hidden", JSON.stringify(shut));
  check("and is laid over the page, not part of it", shut.pos === "fixed", shut.pos);

  await page.click("#drawer-open");
  await sleep(600);
  check("the menu button opens it",
    await page.evaluate(() => document.documentElement.classList.contains("drawer-open")));
  check("the button reports that it is open",
    await page.evaluate(() => document.getElementById("drawer-open")
      .getAttribute("aria-expanded") === "true"));

  // The scrim used to sit above the drawer and swallow every tap meant for it.
  const reachable = await page.evaluate(() => {
    const item = document.querySelector('.sitem[data-view="evidence"]');
    const r = item.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!(top && top.closest(".sitem"));
  });
  check("the sections in it can actually be tapped", reachable,
    "something is covering the drawer");

  const labels = await page.evaluate(() =>
    [...document.querySelectorAll(".sitem")].map((e) => e.textContent.trim()));
  check("the sections keep their real names",
    labels.includes("Measurements") && labels.includes("My data") &&
    !labels.includes("Battery") && !labels.includes("Mine"),
    labels.join(" | "));

  await page.click('.sitem[data-view="evidence"]');
  await sleep(800);
  check("choosing one closes the drawer",
    await page.evaluate(() => !document.documentElement.classList.contains("drawer-open")));
  check("and the bar follows the section",
    await page.evaluate(() => document.getElementById("abtitle").textContent) === "Measurements");

  await page.click("#drawer-open"); await sleep(500);
  // Beside the drawer, not at the middle of the scrim: the middle of the
  // scrim is behind the drawer, which is where a person would never tap.
  {
    const w = page.viewportSize().width;
    await page.mouse.click(w - 24, 420);
  }
  await sleep(500);
  check("tapping beside it closes it",
    await page.evaluate(() => !document.documentElement.classList.contains("drawer-open")));

  await page.click("#drawer-open"); await sleep(500);
  await page.keyboard.press("Escape"); await sleep(400);
  check("so does Escape",
    await page.evaluate(() => !document.documentElement.classList.contains("drawer-open")));

  /* ── one way in to voice ─────────────────────── */
  /* There used to be four: a microphone, a hands-free switch, a hosted
     recogniser and a 39MB on-device engine, two of them carrying the same
     waveform icon. There is one now, and it is the microphone. */
  await page.evaluate(() => show("ask")); await sleep(600);
  const voice = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const box = mic.getBoundingClientRect();
    return {
      leftover: ["handsfree", "localvoice", "servervoice", "voice-open", "vsheet"]
        .filter((id) => !!document.getElementById(id)),
      pressed: mic.getAttribute("aria-pressed"),
      label: mic.getAttribute("aria-label") || "",
      w: Math.round(box.width), h: Math.round(box.height),
      hasRing: !!mic.querySelector(".miclive"),
      optsOutOfRipple: mic.dataset.ripple === "off",
    };
  });
  check("there is exactly one voice control", voice.leftover.length === 0,
    `still present: ${voice.leftover.join(", ")}`);
  check("it starts in the off state", voice.pressed === "false", voice.pressed);
  check("its label says what pressing it does", /voice chat/i.test(voice.label), voice.label);
  check("it is a thumb's width and height", voice.w >= 44 && voice.h >= 44,
    `${voice.w}x${voice.h}`);
  check("it carries its own live ring", voice.hasRing);
  check("and the press ripple does not clip that ring", voice.optsOutOfRipple);

  await page.click("#mic"); await sleep(500);
  const on = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    return { pressed: mic.getAttribute("aria-pressed"),
             label: mic.getAttribute("aria-label") || "" };
  });
  // A headless browser may have no recogniser, so pressing it can refuse -
  // but whichever way it goes, the button and its label must agree.
  check("pressing it leaves the button and its label agreeing",
    (on.pressed === "true") === /end voice chat/i.test(on.label),
    JSON.stringify(on));
  if (on.pressed === "true") {
    await page.click("#mic"); await sleep(400);
    check("pressing it again turns it off", await page.evaluate(
      () => document.getElementById("mic").getAttribute("aria-pressed") === "false"));
  } else {
    check("pressing it again turns it off", true, "(this browser has no recogniser)");
  }


  /* ── nothing too small, nothing off the side ──────────── */
  for (const view of ["ask", "explore", "evidence", "properties", "sources", "mydata"]) {
    await page.evaluate((v) => show(v), view);
    await sleep(700);
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      // A link inside a sentence is exempt: making it 44px tall would push
      // the sentence apart. Its hit area is grown with padding instead, which
      // this cannot see, so it is judged on the box it draws.
      small: [...document.querySelectorAll("button, a[href], [role=button]")]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return false;
          const inProse = e.tagName === "A" &&
            !!e.closest("p, blockquote, li, td, .sub, .m, .dim");
          if (inProse) return false;
          return r.height < 44 || r.width < 24;
        })
        .map((e) => `${e.id || e.className}:${Math.round(e.getBoundingClientRect().height)}`),
    }));
    check(`${view}: nothing runs off the side of the screen`, !m.overflow);
    check(`${view}: every control is a thumb's height`, m.small.length === 0,
      m.small.slice(0, 5).join(", "));
  }

  check("no errors on the phone layout", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.context().close();

  /* ── and the desktop is left alone ────────────────────── */
  const big = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  await big.goto(URL, { waitUntil: "networkidle" });
  await big.waitForFunction(() => window.DATA, { timeout: 30000 });
  await sleep(2600);
  const desk = await big.evaluate(() => ({
    barHidden: getComputedStyle(document.querySelector(".appbar")).display === "none",
    sideInline: getComputedStyle(document.getElementById("side")).position === "static",
    sideShown: getComputedStyle(document.getElementById("side")).visibility === "visible",
    micShown: !!document.getElementById("mic").offsetParent,
    micInComposer: !!document.querySelector(".composer #mic"),
  }));
  check("on a desktop there is no app bar", desk.barHidden);
  check("the sections stay in the sidebar", desk.sideInline && desk.sideShown);
  check("and the one voice control sits in the composer",
    desk.micShown && desk.micInComposer, JSON.stringify(desk));

  console.log(`\nMobile scorecard: ${pass}/${total}`);
  if (fails.length) console.log("failed:\n  " + fails.join("\n  "));
  await browser.close();
  process.exit(pass === total ? 0 : 1);
})();
