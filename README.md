# NexusX PHP backend

The backend is `api.php`. It uses PHP sessions and SQLite, so no external database server is required.

## Run locally

Install PHP with the `pdo_sqlite` extension, then run from this folder:

```powershell
php -S localhost:8000
```

Open `http://localhost:8000/index.html` in the browser. The API is available at `api.php?action=...`.

Supported actions:

- `POST api.php?action=signup` with `name`, `email`, `password`
- `POST api.php?action=login` with `email`, `password`
- `POST api.php?action=logout`
- `GET api.php?action=state`
- `POST api.php?action=deposit` with `amount`, `method`, `account_type`
- `POST api.php?action=withdraw` with `amount`, `method`, `account_type`
- `POST api.php?action=order` with `order_type`, `asset`, `direction`, `price`, `account_type` and `lots` or `amount`
- `POST api.php?action=residency` with `country`, `full_name`, `id_number`, `address`

The `data/nexusx.sqlite` file is created automatically and is ignored by Git.