const userCode = new URLSearchParams(location.search).get("user_code");
if (/^[A-F0-9]{12}$/.test(userCode || "")) {
  document.getElementById("retry-login").href = `/account/login?user_code=${userCode}`;
}
