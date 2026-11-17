import "./env.js";
import { crearApp } from "./app.js";
import { pool } from "./db.js";

const port = Number(process.env.PORT ?? {{PUERTO_API}});
crearApp({ db: pool }).listen(port, () => console.log(`API listening on http://localhost:${port}`));
