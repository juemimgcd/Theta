const copy = document.querySelector("#copy");
if (navigator.clipboard) {
  copy.hidden = false;
  copy.setAttribute("aria-live", "polite");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.querySelector("#commands").textContent);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Select the commands below to copy";
    }
  });
}

const mast = document.querySelector(".mast");
const topAction = document.querySelector(".hero .action");
new IntersectionObserver(([entry]) => {
  mast.classList.toggle("floating", entry.boundingClientRect.bottom < 60);
}, { rootMargin: "-60px 0px 0px" }).observe(topAction);

const motion = matchMedia("(prefers-reduced-motion: reduce)");
for (const card of document.querySelectorAll(".cards article")) {
  const stage = card.querySelector(".stage");
  const title = card.querySelector("h3").textContent;
  const control = document.createElement("button");
  control.type = "button";
  control.className = "demo-control";
  control.setAttribute("aria-label", "Pause demo: " + title);
  card.append(control);

  let visible = false;
  let paused = false;
  function sync() {
    control.hidden = motion.matches;
    control.setAttribute("aria-pressed", String(paused));
    control.title = paused ? "Resume demo" : "Pause demo";
    stage.style.setProperty("--play", visible && !paused && !document.hidden ? "running" : "paused");
  }
  control.addEventListener("click", () => {
    paused = !paused;
    sync();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) card.classList.add("arrived");
    sync();
  }).observe(stage);
  motion.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  stage.classList.add("animated");
  sync();
}
