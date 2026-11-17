package {{PAQUETE}};

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class SaludosTest {
  @Test
  void saludaPorNombre() {
    assertEquals("Hola, Ana", Saludos.saludar("Ana"));
  }

  @Test
  void sinNombreSaludaAlMundo() {
    assertEquals("Hola, mundo", Saludos.saludar("  "));
  }
}
