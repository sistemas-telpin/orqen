package {{PAQUETE}};

/** Pure business logic: no servlet or database, easy to unit test. */
public final class Saludos {
  private Saludos() {}

  public static String saludar(String nombre) {
    return "Hola, " + (nombre == null || nombre.isBlank() ? "mundo" : nombre.trim());
  }
}
