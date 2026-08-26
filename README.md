# BME Detect

Explainable deep learning for **bone marrow edema (BME) detection in MRI**.

Final-year project, Dept. of Computer Science and Engineering, NMAMIT.

| | |
|---|---|
| Elvin Edwin Rodrigues | NNM23CS071 |
| Paripoorna B | NNM23CS124 |
| Reegan Sujal Pinto | NNM23CS149 |
| Aditi H Nayak | NNM23CS293 |

## What it does

Takes an MRI study of a joint and returns a voxel-level segmentation of bone marrow edema,
constrained to lie inside bone marrow — plus lesion volumes, a 3D surface, and an
explanation a clinician can audit.

The model is a cascade: segment bone first, then look for edema only inside that mask. This
makes muscle and joint-fluid false positives structurally impossible rather than something
the network has to learn. Full design in [docs/PRD.md](docs/PRD.md).

## Docs

- **[docs/PRD.md](docs/PRD.md)** — architecture, model choice, evaluation plan, phases
- **[docs/ANNOTATION_SOP.md](docs/ANNOTATION_SOP.md)** — 3D Slicer protocol, export formats, anatomy primer. **Read before annotating.**
- **[CLAUDE.md](CLAUDE.md)** — working rules, git conventions, patient-data handling
- **[ml/README.md](ml/README.md)** — Python pipeline setup

## Patient data

This repo holds **no imaging data and no patient identifiers**, by design. `BME/`, `Non BME/`,
and `data/` are gitignored along with every imaging format. Scans stay local or in access-
controlled storage; the ID-to-name mapping never enters the repo.

If you are adding to this project, read the patient-data section of [CLAUDE.md](CLAUDE.md)
before your first commit.

## Stack

```
client/nextjs/   Next.js web app — upload, MPR viewer, 3D panel, report
client/expo/     Expo mobile client (out of scope for v1)
server/hono/     Hono API gateway — auth, jobs, result serving  (@bme/api)
server/db/       Drizzle ORM + Postgres schema                  (@bme/db)
packages/shared/ Shared TS types — the API contract
ml/              Python: preprocessing, training, inference, quantification, FastAPI
```

PyTorch cannot run on Cloudflare Workers, so `ml/` is a **separate service** the Hono gateway
calls over HTTP. Do not propose moving inference into the worker.

## Setup

```bash
pnpm install
```

Set `DATABASE_URL` in `.env` (Neon or any Postgres), then:

```bash
pnpm migrate:generate initial_schema
```

```bash
pnpm migrate:deploy
```

## Running

Next.js on `3000`, Hono on `8787`, Expo bundler, all concurrently:

```bash
pnpm dev
```

Mobile client only:

```bash
pnpm native
```

Build everything:

```bash
pnpm build
```

For the Python side, see [ml/README.md](ml/README.md).

---

Scaffolded with [create-thunder-stack](https://www.npmjs.com/package/create-thunder-stack).
