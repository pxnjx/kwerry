const $ = id => document.getElementById(id);

function showErr(msg) {
  $("authError").textContent = msg;
  $("authError").classList.remove("hidden");
}
function clearErr() {
  $("authError").classList.add("hidden");
  $("authError").textContent = "";
}

document.querySelectorAll(".auth-tabs .tab").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.auth;
    document.querySelectorAll(".auth-tabs .tab").forEach(b => b.classList.toggle("active", b === btn));
    $("loginForm").classList.toggle("hidden", mode !== "login");
    $("registerForm").classList.toggle("hidden", mode !== "register");
    clearErr();
  });
});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErr();
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: $("loginUser").value,
        password: $("loginPass").value
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Sign in failed.");
    location.href = "/research.html";
  } catch (err) {
    showErr(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErr();
  const pass = $("regPass").value;
  const pass2 = $("regPass2").value;
  if (pass !== pass2) {
    showErr("Passwords do not match.");
    return;
  }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const r = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: $("regUser").value,
        password: pass
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Registration failed.");
    location.href = "/research.html";
  } catch (err) {
    showErr(err.message);
  } finally {
    btn.disabled = false;
  }
});
