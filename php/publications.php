<?php
header('Content-Type: application/json');

require_once __DIR__ . '/bootstrap.php';
narrativa_send_security_headers();
narrativa_start_secure_session();
require_once __DIR__ . '/config.php';

function pub_fail(string $msg, int $code = 400): void {
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $msg]);
    exit;
}

if (!($pdo instanceof PDO)) {
    pub_fail('Base de datos no disponible.', 503);
}

// Create tables if they don't exist
try {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS community_publications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            title VARCHAR(255) NOT NULL,
            author VARCHAR(255) NOT NULL DEFAULT 'Anónimo',
            genre VARCHAR(100) DEFAULT '',
            description TEXT DEFAULT '',
            cover_url TEXT DEFAULT '',
            content LONGTEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user_id (user_id),
            INDEX idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS community_ratings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            publication_id INT NOT NULL,
            user_id INT NOT NULL,
            stars TINYINT NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_user_pub (publication_id, user_id),
            INDEX idx_pub_id (publication_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
} catch (Throwable $e) {
    pub_fail('No se pudo preparar base de datos.', 500);
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

// ── Public: LIST all publications ──────────────────────────────────────────
if ($method === 'GET' && $action === 'list') {
    try {
        $stmt = $pdo->query("
            SELECT 
                p.id, p.user_id, p.title, p.author, p.genre, p.description, p.cover_url, p.created_at,
                ROUND(AVG(r.stars), 1) AS avg_rating,
                COUNT(r.id) AS rating_count
            FROM community_publications p
            LEFT JOIN community_ratings r ON r.publication_id = p.id
            GROUP BY p.id
            ORDER BY p.created_at DESC
            LIMIT 100
        ");
        $rows = $stmt->fetchAll();
        echo json_encode(['success' => true, 'publications' => $rows]);
    } catch (Throwable $e) {
        pub_fail('No se pudieron obtener publicaciones.', 500);
    }
    exit;
}

// ── Public: GET single publication (full content) ───────────────────────────
if ($method === 'GET' && $action === 'get') {
    $pubId = (int)($_GET['id'] ?? 0);
    if (!$pubId) pub_fail('ID inválido.');
    try {
        $stmt = $pdo->prepare("
            SELECT p.*, 
                ROUND(AVG(r.stars),1) as avg_rating,
                COUNT(r.id) as rating_count
            FROM community_publications p
            LEFT JOIN community_ratings r ON r.publication_id = p.id
            WHERE p.id = ?
            GROUP BY p.id
        ");
        $stmt->execute([$pubId]);
        $pub = $stmt->fetch();
        if (!$pub) pub_fail('Publicación no encontrada.', 404);

        // Get user's own rating if logged in
        $myRating = null;
        if (isset($_SESSION['user_id'])) {
            $rs = $pdo->prepare("SELECT stars FROM community_ratings WHERE publication_id=? AND user_id=?");
            $rs->execute([$pubId, (int)$_SESSION['user_id']]);
            $myRating = $rs->fetchColumn() ?: null;
        }
        echo json_encode(['success' => true, 'publication' => $pub, 'myRating' => $myRating]);
    } catch (Throwable $e) {
        pub_fail('Error al obtener publicación.', 500);
    }
    exit;
}

// ── Authenticated actions ────────────────────────────────────────────────────
if (!isset($_SESSION['user_id'])) {
    pub_fail('Debes iniciar sesión.', 401);
}

$userId = (int)$_SESSION['user_id'];
$raw = file_get_contents('php://input');
$data = json_decode($raw, true) ?? [];
$action = $data['action'] ?? $action;

// ── PUBLISH a new work ────────────────────────────────────────────────────────
if ($action === 'publish') {
    if (!narrativa_validate_csrf_header()) pub_fail('Token CSRF inválido.', 403);

    $title  = trim($data['title'] ?? '');
    $author = trim($data['author'] ?? 'Anónimo');
    $genre  = trim($data['genre'] ?? '');
    $desc   = trim($data['description'] ?? '');
    $cover  = trim($data['cover_url'] ?? '');
    $content= trim($data['content'] ?? '');

    if (!$title) pub_fail('El título es obligatorio.');
    if (!$content && !$cover) pub_fail('Debe incluir contenido o una portada.');

    try {
        $stmt = $pdo->prepare("
            INSERT INTO community_publications (user_id, title, author, genre, description, cover_url, content)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([$userId, $title, $author, $genre, $desc, $cover, $content]);
        echo json_encode(['success' => true, 'id' => (int)$pdo->lastInsertId()]);
    } catch (Throwable $e) {
        pub_fail('No se pudo publicar la obra.', 500);
    }
    exit;
}

// ── RATE a publication ───────────────────────────────────────────────────────
if ($action === 'rate') {
    $pubId = (int)($data['publication_id'] ?? 0);
    $stars = (int)($data['stars'] ?? 0);
    if (!$pubId) pub_fail('ID de publicación inválido.');
    if ($stars < 1 || $stars > 5) pub_fail('La calificación debe ser entre 1 y 5 estrellas.');

    try {
        // Check the publication exists
        $chk = $pdo->prepare("SELECT id, user_id FROM community_publications WHERE id=? LIMIT 1");
        $chk->execute([$pubId]);
        $pub = $chk->fetch();
        if (!$pub) pub_fail('Publicación no encontrada.', 404);
        if ((int)$pub['user_id'] === $userId) pub_fail('No puedes calificar tu propia obra.');

        $stmt = $pdo->prepare("
            INSERT INTO community_ratings (publication_id, user_id, stars)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE stars = VALUES(stars), created_at = CURRENT_TIMESTAMP
        ");
        $stmt->execute([$pubId, $userId, $stars]);

        // Return updated average
        $avg = $pdo->prepare("SELECT ROUND(AVG(stars),1) as avg, COUNT(*) as cnt FROM community_ratings WHERE publication_id=?");
        $avg->execute([$pubId]);
        $result = $avg->fetch();
        echo json_encode(['success' => true, 'avg_rating' => $result['avg'], 'rating_count' => $result['cnt']]);
    } catch (Throwable $e) {
        pub_fail('No se pudo registrar la calificación.', 500);
    }
    exit;
}

// ── DELETE own publication ───────────────────────────────────────────────────
if ($action === 'update') {
    if (!narrativa_validate_csrf_header()) pub_fail('Token CSRF inválido.', 403);
    $pubId = (int)($data['publication_id'] ?? 0);
    if (!$pubId) pub_fail('ID inválido.');

    $title  = trim($data['title'] ?? '');
    $author = trim($data['author'] ?? 'Anónimo');
    $genre  = trim($data['genre'] ?? '');
    $desc   = trim($data['description'] ?? '');
    $cover  = trim($data['cover_url'] ?? '');
    $content= trim($data['content'] ?? '');

    if (!$title) pub_fail('El título es obligatorio.');
    if (!$content && !$cover) pub_fail('Debe incluir contenido o una portada.');

    try {
        $chk = $pdo->prepare("SELECT user_id FROM community_publications WHERE id=? LIMIT 1");
        $chk->execute([$pubId]);
        $pub = $chk->fetch();
        if (!$pub) pub_fail('Publicación no encontrada.', 404);
        if ((int)$pub['user_id'] !== $userId) pub_fail('No tienes permiso para editar esta publicación.', 403);

        $stmt = $pdo->prepare("
            UPDATE community_publications
            SET title = ?, author = ?, genre = ?, description = ?, cover_url = ?, content = ?
            WHERE id = ? AND user_id = ?
            LIMIT 1
        ");
        $stmt->execute([$title, $author, $genre, $desc, $cover, $content, $pubId, $userId]);
        echo json_encode(['success' => true, 'id' => $pubId]);
    } catch (Throwable $e) {
        pub_fail('No se pudo actualizar la publicación.', 500);
    }
    exit;
}

if ($action === 'delete') {
    if (!narrativa_validate_csrf_header()) pub_fail('Token CSRF inválido.', 403);
    $pubId = (int)($data['publication_id'] ?? 0);
    if (!$pubId) pub_fail('ID inválido.');

    try {
        $chk = $pdo->prepare("SELECT user_id FROM community_publications WHERE id=? LIMIT 1");
        $chk->execute([$pubId]);
        $pub = $chk->fetch();
        if (!$pub) pub_fail('Publicación no encontrada.', 404);
        if ((int)$pub['user_id'] !== $userId) pub_fail('No tienes permiso.', 403);

        $pdo->prepare("DELETE FROM community_ratings WHERE publication_id=?")->execute([$pubId]);
        $pdo->prepare("DELETE FROM community_publications WHERE id=?")->execute([$pubId]);
        echo json_encode(['success' => true]);
    } catch (Throwable $e) {
        pub_fail('No se pudo eliminar.', 500);
    }
    exit;
}

pub_fail('Acción no soportada.');
