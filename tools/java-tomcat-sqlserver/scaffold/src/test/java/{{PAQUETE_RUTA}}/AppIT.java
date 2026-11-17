package {{PAQUETE}};

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import org.junit.jupiter.api.Test;

/** Integration: needs SQL Server and Tomcat running (orqen env up) and the migrations applied. */
class AppIT {
  @Test
  void laAppLlegaALaBase() throws Exception {
    String base = System.getenv().getOrDefault("APP_URL", "http://localhost:{{PUERTO_APP}}");
    HttpResponse<String> r = HttpClient.newHttpClient()
        .send(HttpRequest.newBuilder(URI.create(base + "/health")).build(), HttpResponse.BodyHandlers.ofString());
    assertEquals(200, r.statusCode(), r.body());
    assertTrue(r.body().contains("\"db\":\"ok\""), r.body());
  }

  @Test
  void laMigracionCreoLaTablaEjemplo() throws Exception {
    assumeTrue(Db.configurada(), "DB_URL is not set");
    try (Connection c = Db.conectar(); Statement s = c.createStatement();
         ResultSet rs = s.executeQuery("SELECT OBJECT_ID('dbo.ejemplo')")) {
      rs.next();
      assertTrue(rs.getObject(1) != null);
    }
  }
}
