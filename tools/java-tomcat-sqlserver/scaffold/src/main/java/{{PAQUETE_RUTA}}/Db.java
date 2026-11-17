package {{PAQUETE}};

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

/** Database connection from the DB_URL, DB_USER and DB_PASSWORD environment variables. */
public final class Db {
  private Db() {}

  public static boolean configurada() {
    return System.getenv("DB_URL") != null;
  }

  public static Connection conectar() throws SQLException {
    return DriverManager.getConnection(System.getenv("DB_URL"), System.getenv("DB_USER"), System.getenv("DB_PASSWORD"));
  }
}
