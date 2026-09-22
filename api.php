<?php
declare(strict_types=1);

session_start();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const DEMO_STARTING_BALANCE = 10000.00;
const BINARY_PAYOUT = 0.85;

function respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function requestBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        respond(['error' => 'Request body must be valid JSON.'], 400);
    }
    return $data;
}

function requireFields(array $data, array $fields): void
{
    foreach ($fields as $field) {
        if (!isset($data[$field]) || trim((string) $data[$field]) === '') {
            respond(['error' => "Missing required field: {$field}"], 422);
        }
    }
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dataDir = __DIR__ . DIRECTORY_SEPARATOR . 'data';
    if (!is_dir($dataDir) && !mkdir($dataDir, 0750, true) && !is_dir($dataDir)) {
        respond(['error' => 'Unable to create application data directory.'], 500);
    }

    try {
        $pdo = new PDO('sqlite:' . $dataDir . DIRECTORY_SEPARATOR . 'nexusx.sqlite');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    demo_balance REAL NOT NULL DEFAULT 10000,
    real_balance REAL NOT NULL DEFAULT 0,
    residency_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
    residency_data TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_type TEXT NOT NULL CHECK (account_type IN ('DEMO', 'REAL')),
    order_type TEXT NOT NULL CHECK (order_type IN ('FOREX', 'BINARY')),
    asset TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount REAL NOT NULL,
    lots REAL,
    price REAL NOT NULL,
    expiry_seconds INTEGER,
    expiry_at TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    method TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
SQL);
    } catch (Throwable $error) {
        respond(['error' => 'Database initialization failed.'], 500);
    }
    return $pdo;
}

function currentUser(): ?array
{
    if (!isset($_SESSION['user_id'])) {
        return null;
    }
    $query = db()->prepare('SELECT * FROM users WHERE id = ?');
    $query->execute([(int) $_SESSION['user_id']]);
    return $query->fetch() ?: null;
}

function requireUser(): array
{
    $user = currentUser();
    if (!$user) {
        respond(['error' => 'Authentication required.'], 401);
    }
    return $user;
}

function balanceColumn(string $accountType): string
{
    return strtoupper($accountType) === 'REAL' ? 'real_balance' : 'demo_balance';
}

function publicState(array $user): array
{
    $pdo = db();
    $orders = $pdo->prepare('SELECT id, account_type, order_type, asset, direction, amount, lots, price, expiry_seconds, expiry_at, status, created_at FROM orders WHERE user_id = ? ORDER BY id DESC');
    $orders->execute([(int) $user['id']]);
    $transactions = $pdo->prepare('SELECT id, type, method, amount, status, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC');
    $transactions->execute([(int) $user['id']]);

    return [
        'user' => ['id' => (int) $user['id'], 'name' => $user['name'], 'email' => $user['email']],
        'balances' => ['DEMO' => (float) $user['demo_balance'], 'REAL' => (float) $user['real_balance']],
        'residency' => [
            'status' => $user['residency_status'],
            'data' => $user['residency_data'] ? json_decode($user['residency_data'], true) : null,
        ],
        'orders' => $orders->fetchAll(),
        'transactions' => $transactions->fetchAll(),
    ];
}

function handle(): void
{
    $action = $_GET['action'] ?? 'state';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $data = $method === 'POST' ? requestBody() : [];
    $pdo = db();

    if ($action === 'signup' && $method === 'POST') {
        requireFields($data, ['name', 'email', 'password']);
        $email = strtolower(trim((string) $data['email']));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen((string) $data['password']) < 8) {
            respond(['error' => 'Use a valid email and a password of at least 8 characters.'], 422);
        }
        try {
            $query = $pdo->prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)');
            $query->execute([trim((string) $data['name']), $email, password_hash((string) $data['password'], PASSWORD_DEFAULT)]);
            $_SESSION['user_id'] = (int) $pdo->lastInsertId();
        } catch (PDOException $error) {
            respond(['error' => 'An account with that email already exists.'], 409);
        }
        respond(['state' => publicState(requireUser())], 201);
    }

    if ($action === 'login' && $method === 'POST') {
        requireFields($data, ['email', 'password']);
        $query = $pdo->prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
        $query->execute([trim((string) $data['email'])]);
        $user = $query->fetch();
        if (!$user || !password_verify((string) $data['password'], $user['password_hash'])) {
            respond(['error' => 'Invalid email or password.'], 401);
        }
        session_regenerate_id(true);
        $_SESSION['user_id'] = (int) $user['id'];
        respond(['state' => publicState($user)]);
    }

    if ($action === 'logout' && $method === 'POST') {
        $_SESSION = [];
        session_destroy();
        respond(['success' => true]);
    }

    $user = requireUser();
    if ($action === 'state' && $method === 'GET') {
        respond(['state' => publicState($user)]);
    }

    if ($action === 'deposit' && $method === 'POST') {
        requireFields($data, ['amount', 'method', 'account_type']);
        $amount = (float) $data['amount'];
        $accountType = strtoupper((string) $data['account_type']);
        if ($amount <= 0 || !in_array($accountType, ['DEMO', 'REAL'], true)) {
            respond(['error' => 'Invalid deposit details.'], 422);
        }
        $column = balanceColumn($accountType);
        $pdo->beginTransaction();
        $pdo->prepare("UPDATE users SET {$column} = {$column} + ? WHERE id = ?")->execute([$amount, $user['id']]);
        $pdo->prepare("INSERT INTO transactions (user_id, type, method, amount, status) VALUES (?, 'DEPOSIT', ?, ?, 'COMPLETED')")->execute([$user['id'], $data['method'], $amount]);
        $pdo->commit();
        respond(['state' => publicState(currentUser())], 201);
    }

    if ($action === 'withdraw' && $method === 'POST') {
        requireFields($data, ['amount', 'method', 'account_type']);
        $amount = (float) $data['amount'];
        $accountType = strtoupper((string) $data['account_type']);
        $column = balanceColumn($accountType);
        if ($amount <= 0 || !in_array($accountType, ['DEMO', 'REAL'], true) || $amount > (float) $user[$column]) {
            respond(['error' => 'Invalid withdrawal or insufficient balance.'], 422);
        }
        if ($user['residency_status'] !== 'VERIFIED' && $amount > 1000) {
            respond(['error' => 'Unverified accounts may withdraw a maximum of $1,000.'], 422);
        }
        $pdo->beginTransaction();
        $pdo->prepare("UPDATE users SET {$column} = {$column} - ? WHERE id = ?")->execute([$amount, $user['id']]);
        $pdo->prepare("INSERT INTO transactions (user_id, type, method, amount, status) VALUES (?, 'WITHDRAWAL', ?, ?, 'PENDING')")->execute([$user['id'], $data['method'], $amount]);
        $pdo->commit();
        respond(['state' => publicState(currentUser())], 201);
    }

    if ($action === 'order' && $method === 'POST') {
        requireFields($data, ['order_type', 'asset', 'direction', 'price', 'account_type']);
        $orderType = strtoupper((string) $data['order_type']);
        $accountType = strtoupper((string) $data['account_type']);
        $amount = (float) ($data['amount'] ?? 0);
        $lots = isset($data['lots']) ? (float) $data['lots'] : null;
        if (!in_array($orderType, ['FOREX', 'BINARY'], true) || !in_array($accountType, ['DEMO', 'REAL'], true) || (float) $data['price'] <= 0) {
            respond(['error' => 'Invalid order details.'], 422);
        }
        if ($orderType === 'FOREX') {
            if ($lots === null || $lots <= 0 || $lots > 100) {
                respond(['error' => 'Forex lots must be between 0.01 and 100.'], 422);
            }
            $amount = 0;
        } elseif ($amount < 5) {
            respond(['error' => 'Binary investment must be at least $5.'], 422);
        }
        $column = balanceColumn($accountType);
        if ($amount > (float) $user[$column]) {
            respond(['error' => 'Insufficient account balance.'], 422);
        }
        $expirySeconds = $orderType === 'BINARY' ? (int) ($data['expiry_seconds'] ?? 60) : null;
        $expiryAt = $expirySeconds ? gmdate('Y-m-d H:i:s', time() + $expirySeconds) : null;
        $pdo->beginTransaction();
        if ($amount > 0) {
            $pdo->prepare("UPDATE users SET {$column} = {$column} - ? WHERE id = ?")->execute([$amount, $user['id']]);
        }
        $query = $pdo->prepare('INSERT INTO orders (user_id, account_type, order_type, asset, direction, amount, lots, price, expiry_seconds, expiry_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $query->execute([$user['id'], $accountType, $orderType, trim((string) $data['asset']), strtoupper((string) $data['direction']), $amount, $lots, (float) $data['price'], $expirySeconds, $expiryAt]);
        $pdo->commit();
        respond(['state' => publicState(currentUser())], 201);
    }

    if ($action === 'residency' && $method === 'POST') {
        requireFields($data, ['country', 'full_name', 'id_number', 'address']);
        $residency = ['country' => trim((string) $data['country']), 'fullName' => trim((string) $data['full_name']), 'idNum' => trim((string) $data['id_number']), 'address' => trim((string) $data['address']), 'idAttached' => !empty($data['id_attached']), 'addressAttached' => !empty($data['address_attached'])];
        $query = $pdo->prepare("UPDATE users SET residency_status = 'PENDING', residency_data = ? WHERE id = ?");
        $query->execute([json_encode($residency), $user['id']]);
        respond(['state' => publicState(currentUser())], 201);
    }

    respond(['error' => 'Unknown action or method.'], 404);
}

try {
    handle();
} catch (Throwable $error) {
    if (db()->inTransaction()) {
        db()->rollBack();
    }
    respond(['error' => 'Unexpected server error.'], 500);
}