const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('ssh2');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const userSessions = {};

io.on('connection', (socket) => {
    console.log(`[${socket.id}] Пользователь подключился к WebSocket`);
    userSessions[socket.id] = { ssh: null, sftp: null, shell: null };

    socket.on('ssh-connect', (credentials) => {
        console.log(`[${socket.id}] Попытка SSH подключения к ${credentials.host}...`);
        const conn = new Client();
        
        conn.on('ready', () => {
            userSessions[socket.id].ssh = conn;
            console.log(`[${socket.id}] Основное SSH соединение установлено. Запуск подсистемы SFTP...`);

            conn.sftp((err, sftp) => {
                if (err) {
                    console.error(`[${socket.id}] Ошибка инициализации SFTP:`, err.message);
                    socket.emit('status', { success: false, error: 'Не удалось запустить подсистему файлов (SFTP): ' + err.message });
                    conn.end();
                    return;
                }
                
                userSessions[socket.id].sftp = sftp;
                console.log(`[${socket.id}] Подсистема SFTP успешно запущена. Запуск интерактивного Shell...`);

                conn.shell({ term: 'xterm', cols: 80, rows: 24 }, (err, stream) => {
                    if (err) {
                        console.error(`[${socket.id}] Ошибка запуска Shell:`, err.message);
                        socket.emit('status', { success: false, error: 'Не удалось запустить терминал (Shell): ' + err.message });
                        conn.end();
                        return;
                    }
                    
                    userSessions[socket.id].shell = stream;
                    console.log(`[${socket.id}] Shell (PTY) запущен успешно.`);

                    stream.on('data', (data) => {
                        socket.emit('terminal-data', data.toString('utf-8'));
                    });

                    stream.on('close', () => {
                        console.log(`[${socket.id}] Поток Shell закрыт удаленным сервером`);
                        socket.emit('terminal-data', '\r\n[SSH Сессия закрыта сервером]\r\n');
                    });

                    socket.emit('status', { success: true, message: 'Успешно подключено к SSH и SFTP' });
                });
            });
        });

        conn.on('error', (err) => {
            console.error(`[${socket.id}] Ошибка SSH-клиента:`, err.message);
            socket.emit('status', { success: false, error: 'Ошибка SSH: ' + err.message });
        });

        try {
            conn.connect({
                host: credentials.host,
                port: parseInt(credentials.port) || 22,
                username: credentials.user,
                password: credentials.pass,
                readyTimeout: 15000
            });
        } catch (e) {
            socket.emit('status', { success: false, error: 'Неверные параметры подключения: ' + e.message });
        }
    });

    socket.on('terminal-write', (data) => {
        const session = userSessions[socket.id];
        if (session && session.shell) {
            session.shell.write(data);
        }
    });

    socket.on('terminal-resize', (size) => {
        const session = userSessions[socket.id];
        if (session && session.shell) {
            session.shell.setWindow(size.rows, size.cols, 0, 0);
        }
    });

    socket.on('get-dir', (targetPath) => {
        const session = userSessions[socket.id];
        if (!session || !session.sftp) {
            return socket.emit('dir-data', { success: false, error: 'Нет активного подключения к SFTP' });
        }

        session.sftp.readdir(targetPath, (err, list) => {
            if (err) {
                console.error(`[${socket.id}] Ошибка чтения папки ${targetPath}:`, err.message);
                return socket.emit('dir-data', { success: false, error: err.message });
            }

            const subfolders = [];
            const files = [];

            list.forEach(item => {
                if (item.filename !== '.' && item.filename !== '..') {
                    const isDir = (item.attrs.mode & 0o170000) === 0o040000;
                    if (isDir) subfolders.push(item.filename);
                    else files.push(item.filename);
                }
            });

            subfolders.sort();
            files.sort();
            socket.emit('dir-data', { success: true, subfolders, files, currentPath: targetPath });
        });
    });

    // --- НОВЫЕ ФУНКЦИИ УПРАВЛЕНИЯ ФАЙЛАМИ ---

    // Создание файла или папки
    socket.on('create-item', (data) => {
        const session = userSessions[socket.id];
        if (!session || !session.sftp) return;

        if (data.type === 'folder') {
            session.sftp.mkdir(data.path, (err) => {
                socket.emit('file-operation-result', { success: !err, error: err ? err.message : null });
            });
        } else {
            session.sftp.writeFile(data.path, '', 'utf-8', (err) => {
                socket.emit('file-operation-result', { success: !err, error: err ? err.message : null });
            });
        }
    });

    // Переименование файла или папки
    socket.on('rename-item', (data) => {
        const session = userSessions[socket.id];
        if (!session || !session.sftp) return;

        session.sftp.rename(data.oldPath, data.newPath, (err) => {
            socket.emit('file-operation-result', { success: !err, error: err ? err.message : null });
        });
    });

    // Удаление файла или папки
    socket.on('delete-item', (data) => {
        const session = userSessions[socket.id];
        if (!session || !session.sftp) return;

        if (data.type === 'folder') {
            session.sftp.rmdir(data.path, (err) => {
                socket.emit('file-operation-result', { success: !err, error: err ? err.message : null });
            });
        } else {
            session.sftp.unlink(data.path, (err) => {
                socket.emit('file-operation-result', { success: !err, error: err ? err.message : null });
            });
        }
    });

    // Чтение содержимого файла
    socket.on('read-file', (filePath) => {
        const session = userSessions[socket.id];
        if (!session || !session.sftp) return;

        session.sftp.readFile(filePath, 'utf-8', (err, data) => {
            if (err) socket.emit('file-content', { success: false, error: err.message });
            else socket.emit('file-content', { success: true, path: filePath, content: data });
        });
    });

    // Сохранение изменений в файл
    socket.on('save-file', (fileData) => {
        const session = userSessions[socket.id];
        if (!session || !session.sftp) return;

        session.sftp.writeFile(fileData.path, fileData.content, 'utf-8', (err) => {
            if (err) socket.emit('save-status', { success: false, error: err.message });
            else socket.emit('save-status', { success: true });
        });
    });

    socket.on('disconnect', () => {
        console.log(`[${socket.id}] Пользователь разорвал WebSocket-соединение`);
        const session = userSessions[socket.id];
        if (session) {
            if (session.shell) try { session.shell.end(); } catch(e){}
            if (session.sftp) try { session.sftp.end(); } catch(e){}
            if (session.ssh) try { session.ssh.end(); } catch(e){}
            delete userSessions[socket.id];
        }
    });
});

const PORT = 5000;
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` Node.js Web SSH IDE бэкенд успешно запущен!`);
    console.log(` Адрес локального сервера: http://localhost:${PORT}`);
    console.log(`====================================================`);
});