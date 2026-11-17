package {{PAQUETE}};

import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.sql.Connection;
import java.sql.Statement;

/** GET /health: used by orqen to know the app is up (and whether it reaches the database). */
@WebServlet("/health")
public class HealthServlet extends HttpServlet {
  @Override
  protected void doGet(HttpServletRequest req, HttpServletResponse res) throws IOException {
    res.setContentType("application/json");
    if (!Db.configurada()) {
      res.getWriter().write("{\"status\":\"ok\",\"db\":\"not configured\"}");
      return;
    }
    try (Connection c = Db.conectar(); Statement s = c.createStatement()) {
      s.execute("SELECT 1");
      res.getWriter().write("{\"status\":\"ok\",\"db\":\"ok\"}");
    } catch (Exception e) {
      res.setStatus(503);
      res.getWriter().write("{\"status\":\"error\",\"db\":\"" + e.getMessage().replace("\"", "'") + "\"}");
    }
  }
}
