// auth.js - manejo sencillo de login con POO
class Auth {
  constructor() {
    this.currentUser = null;
    this.credentials = JSON.parse(localStorage.getItem("credentials") || "[]");
  }

  saveCreds() {
    localStorage.setItem("credentials", JSON.stringify(this.credentials));
  }

  register(user, pass) {
    if (!user || !pass) throw new Error("Usuario y contraseña requeridos");
    if (this.credentials.some(c => c.user === user)) throw new Error("Usuario ya existe");
    this.credentials.push({ user, pass });
    this.saveCreds();
    return true;
  }

  login(user, pass) {
    const found = this.credentials.find(c => c.user === user && c.pass === pass);
    if (!found) throw new Error("Credenciales inválidas");
    this.currentUser = user;
    sessionStorage.setItem("sessionUser", user);
    this.updateNavbar();
    return true;
  }

  logout() {
    this.currentUser = null;
    sessionStorage.removeItem("sessionUser");
    this.updateNavbar();
  }

  isLoggedIn() {
    if (this.currentUser) return true;
    const saved = sessionStorage.getItem("sessionUser");
    if (saved) {
      this.currentUser = saved;
      return true;
    }
    return false;
  }

  updateNavbar() {
    const userArea = document.getElementById("userArea");
    if (this.isLoggedIn()) {
      userArea.innerHTML = `
        <span class="text-white me-2">👤 ${this.currentUser}</span>
        <button class="btn btn-outline-warning" id="btnLogout">Cerrar Sesión</button>
      `;
      document.getElementById("btnLogout").addEventListener("click", () => this.logout());
    } else {
      userArea.innerHTML = `
        <button class="btn btn-success" data-bs-toggle="modal" data-bs-target="#loginModal">Iniciar/Registrar</button>
      `;
    }
  }
}

// Instancia global
window.auth = new Auth();
document.addEventListener("DOMContentLoaded", () => {
  auth.updateNavbar();

  // Botones login/registro
  document.getElementById("btnRegister").addEventListener("click", () => {
    const u = document.getElementById("regUser").value.trim();
    const p = document.getElementById("regPass").value.trim();
    const msg = document.getElementById("regMsg");
    msg.textContent = "";
    try {
      auth.register(u, p);
      msg.innerHTML = '<small class="text-success">Registrado correctamente</small>';
    } catch (e) {
      msg.innerHTML = `<small class="text-danger">${e.message}</small>`;
    }
  });

  document.getElementById("btnLogin").addEventListener("click", () => {
    const u = document.getElementById("loginUser").value.trim();
    const p = document.getElementById("loginPass").value.trim();
    const msg = document.getElementById("loginMsg");
    msg.textContent = "";
    try {
      auth.login(u, p);
      msg.innerHTML = '<small class="text-success">Ingreso exitoso</small>';
      new bootstrap.Modal(document.getElementById("loginModal")).hide();
    } catch (e) {
      msg.innerHTML = `<small class="text-danger">${e.message}</small>`;
    }
  });
});
