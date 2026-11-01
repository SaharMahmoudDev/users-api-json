const COLUMNS = ["name", "email", "avatar", "createdAt", "password"];
const SORTABLE = ["id", ...COLUMNS];
const MAX_USERS = 300;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Accept",
  "Access-Control-Expose-Headers": "X-Total-Count,Link",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  } catch {
    return null;
  }
}

function pick(body) {
  const out = {};
  for (const column of COLUMNS) {
    if (body[column] !== undefined) out[column] = String(body[column]);
  }
  return out;
}

async function list(db, url) {
  const params = url.searchParams;
  const q = params.get("q")?.trim().toLowerCase();
  const sort = SORTABLE.includes(params.get("_sort"))
    ? params.get("_sort")
    : "id";
  const order = params.get("_order")?.toLowerCase() === "desc" ? "DESC" : "ASC";
  const page = Math.max(1, Number(params.get("_page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(params.get("_limit")) || 10));
  const paged = params.has("_page") || params.has("_limit");

  const where = [];
  const binds = [];

  if (q) {
    where.push(
      "(" +
        COLUMNS.map((c) => `lower(${c}) LIKE ?`).join(" OR ") +
        " OR CAST(id AS TEXT) LIKE ?)",
    );
    for (let i = 0; i <= COLUMNS.length; i++) binds.push(`%${q}%`);
  }

  for (const column of SORTABLE) {
    const value = params.get(column);
    if (value !== null) {
      where.push(`${column} = ?`);
      binds.push(column === "id" ? Number(value) : value);
    }
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { results: counted } = await db
    .prepare(`SELECT COUNT(*) AS total FROM users ${clause}`)
    .bind(...binds)
    .all();
  const total = counted[0].total;

  const sql = `SELECT * FROM users ${clause} ORDER BY ${sort} ${order}${
    sort === "id" ? "" : ", id ASC"
  }${paged ? " LIMIT ? OFFSET ?" : ""}`;
  const pageBinds = paged ? [...binds, limit, (page - 1) * limit] : binds;

  const { results } = await db
    .prepare(sql)
    .bind(...pageBinds)
    .all();
  return json(results, 200, { "X-Total-Count": String(total) });
}

async function getOne(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0) {
      return json({ name: "users-api", resources: ["/users"] });
    }
    if (parts[0] !== "users" || parts.length > 2) {
      return json({}, 404);
    }

    const db = env.DB;
    const id = parts[1] === undefined ? null : Number(parts[1]);
    if (parts[1] !== undefined && !Number.isInteger(id)) return json({}, 404);

    if (id === null) {
      if (request.method === "GET") return list(db, url);
      if (request.method === "POST") {
        const body = await readBody(request);
        if (!body) return json({ message: "Invalid JSON body" }, 400);

        const { results } = await db
          .prepare("SELECT COUNT(*) AS total FROM users")
          .all();
        if (results[0].total >= MAX_USERS) {
          return json({ message: "User limit reached for this demo" }, 429);
        }

        const data = pick(body);
        const row = await db
          .prepare(
            "INSERT INTO users (name, email, avatar, createdAt, password) VALUES (?, ?, ?, ?, ?) RETURNING *",
          )
          .bind(
            data.name ?? "",
            data.email ?? "",
            data.avatar ?? "",
            data.createdAt ?? new Date().toISOString(),
            data.password ?? "",
          )
          .first();
        return json(row, 201);
      }
      return json({}, 405);
    }

    const existing = await getOne(db, id);
    if (!existing) return json({}, 404);

    if (request.method === "GET") return json(existing);

    if (request.method === "DELETE") {
      await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      return json({});
    }

    if (request.method === "PUT" || request.method === "PATCH") {
      const body = await readBody(request);
      if (!body) return json({ message: "Invalid JSON body" }, 400);

      const data = pick(body);
      const next =
        request.method === "PUT"
          ? {
              name: "",
              email: "",
              avatar: "",
              createdAt: existing.createdAt,
              password: "",
              ...data,
            }
          : { ...existing, ...data };

      const row = await db
        .prepare(
          "UPDATE users SET name = ?, email = ?, avatar = ?, createdAt = ?, password = ? WHERE id = ? RETURNING *",
        )
        .bind(
          next.name,
          next.email,
          next.avatar,
          next.createdAt,
          next.password,
          id,
        )
        .first();
      return json(row);
    }

    return json({}, 405);
  },
};
