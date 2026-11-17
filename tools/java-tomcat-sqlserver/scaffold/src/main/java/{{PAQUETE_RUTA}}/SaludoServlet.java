package {{PAQUETE}};

import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/** GET /api/saludo?nombre=Ana */
@WebServlet("/api/saludo")
public class SaludoServlet extends HttpServlet {
  @Override
  protected void doGet(HttpServletRequest req, HttpServletResponse res) throws IOException {
    res.setContentType("application/json");
    res.setCharacterEncoding("UTF-8");
    res.getWriter().write("{\"mensaje\":\"" + Saludos.saludar(req.getParameter("nombre")).replace("\"", "'") + "\"}");
  }
}
