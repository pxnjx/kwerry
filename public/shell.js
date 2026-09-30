// Shared auth chrome: user menu, sign-out confirm modal.
(function () {
  const $ = id => document.getElementById(id);

  async function loadUser() {
    try {
      const r = await fetch("/api/auth/me");
      const d = await r.json();
      if (!r.ok) {
        location.href = "/login.html";
        return;
      }
      const name = d.user.username;
      const label = $("sideUser");
      if (label) label.textContent = name;
      const full = $("sideUserName");
      if (full) full.textContent = name;
    } catch {
      location.href = "/login.html";
    }
  }

  // User popover
  const userBtn = $("userMenuBtn");
  const userPop = $("userPopover");
  if (userBtn && userPop) {
    userBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      userPop.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!userPop.contains(e.target) && e.target !== userBtn) {
        userPop.classList.add("hidden");
      }
    });
  }

  // Logout confirm modal
  const logoutModal = $("logoutModal");
  const openLogout = $("openLogoutBtn");
  const cancelLogout = $("cancelLogout");
  const confirmLogout = $("confirmLogout");

  function openLogoutModal() {
    if (userPop) userPop.classList.add("hidden");
    if (logoutModal) logoutModal.classList.remove("hidden");
  }
  function closeLogoutModal() {
    if (logoutModal) logoutModal.classList.add("hidden");
  }

  if (openLogout) openLogout.addEventListener("click", openLogoutModal);
  if (cancelLogout) cancelLogout.addEventListener("click", closeLogoutModal);
  if (logoutModal) {
    logoutModal.addEventListener("click", e => {
      if (e.target === logoutModal) closeLogoutModal();
    });
  }
  if (confirmLogout) {
    confirmLogout.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      location.href = "/login.html";
    });
  }

  loadUser();
})();
