<?php
// Configuration for Database Connection
$host = 'localhost';
$db   = 'u136648540_narrativa_db';
$user = 'u136648540_narrativa_user';
$pass = 'Tierra2026';
$charset = 'utf8mb4';
$pdo = null;
$db_connection_error = null;

$dsn = "mysql:host=$host;dbname=$db;charset=$charset";
$options = [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => false,
];

try {
     $pdo = new PDO($dsn, $user, $pass, $options);
} catch (\PDOException $e) {
     $db_connection_error = $e->getMessage();
}
?>
