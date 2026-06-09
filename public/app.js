const socket = io();

let term, fitAddon;
let currentActivePath = "/";
let currentOpenedFilePath = null;
let selectedFileInList = null; // Храним имя выделенного в данный момент файла/папки

window.onload = function() {
    term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Consolas, Courier New, monospace',
        theme: { background: '#000000', foreground: '#ffffff' }
    });
    
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-canvas'));
    term.writeln("Ожидание подключения к SSH...");

    term.onData(data => {
        socket.emit('terminal-write', data);
    });

    makeElementDraggable(document.getElementById("window-terminal"));
    new ResizeObserver(() => { fitTerminal(); }).observe(document.getElementById("window-terminal"));
};

socket.on('terminal-data', (data) => {
    term.write(data);
});

function connect() {
    document.getElementById('status').innerText = "Статус: Подключение...";
    socket.emit('ssh-connect', {
        host: document.getElementById('host').value,
        user: document.getElementById('user').value,
        pass: document.getElementById('pass').value
    });
}

socket.on('status', (data) => {
    if (data.success) {
        document.getElementById('status').innerText = "Статус: Успешно подключено";
        document.getElementById('term-toggle-btn').style.display = 'block';
        document.getElementById('file-actions-bar').style.display = 'flex'; // Показываем тулбар файлов
        document.getElementById('window-terminal').style.display = 'flex';
        document.getElementById('term-toggle-btn').innerText = "📺 Скрыть терминал";
        
        currentActivePath = "/";
        socket.emit('get-dir', currentActivePath);
        setTimeout(fitTerminal, 50);
    } else {
        document.getElementById('status').innerText = "Ошибка: " + data.error;
    }
});

socket.on('dir-data', (data) => {
    if (!data.success) return alert("Ошибка чтения директории: " + data.error);

    document.getElementById('current-path-label').innerText = "Путь: " + data.currentPath;
    const select = document.getElementById('folder-select');
    select.innerHTML = '';

    const defOpt = document.createElement('option');
    defOpt.value = ""; defOpt.disabled = true; defOpt.selected = true;
    defOpt.innerText = "📁 В подпапку...";
    select.appendChild(defOpt);

    if (data.currentPath !== "/") {
        const backOpt = document.createElement('option');
        backOpt.value = ".."; backOpt.innerText = "📁 .. [Вверх]";
        select.appendChild(backOpt);
    }

    data.subfolders.forEach(folder => {
        const opt = document.createElement('option');
        opt.value = folder; opt.innerText = "📁 " + folder;
        select.appendChild(opt);
    });

    // Сбрасываем выделенный файл при перезагрузке папки
    selectedFileInList = null;
    renderFiles(data.files, data.currentPath);
});

function onFolderChange() {
    const select = document.getElementById('folder-select');
    const chosen = select.value;
    if (!chosen) return;

    if (chosen === "..") {
        let segments = currentActivePath.split('/').filter(Boolean);
        segments.pop();
        currentActivePath = "/" + segments.join('/');
    } else {
        currentActivePath = currentActivePath === "/" ? "/" + chosen : currentActivePath.replace(/\/$/, "") + "/" + chosen;
    }

    socket.emit('terminal-write', `cd "${currentActivePath}"\r`);
    socket.emit('get-dir', currentActivePath);
}

function renderFiles(files, parentPath) {
    const container = document.getElementById('files-list');
    container.innerHTML = '';
    
    if(files.length === 0) {
        container.innerHTML = '<div class="empty-list-label">Файлов нет</div>';
        return;
    }

    files.forEach(file => {
        const div = document.createElement('div');
        div.className = 'file-item';
        div.innerText = '📄 ' + file;
        
        let fullPath = parentPath === "/" ? "/" + file : parentPath.replace(/\/$/, "") + "/" + file;
        
        // Клик выбирает файл и подсвечивает его, двойной клик открывает в редакторе
        div.onclick = (e) => {
            document.querySelectorAll('.file-item').forEach(el => el.style.backgroundColor = '');
            div.style.backgroundColor = '#0e639c';
            selectedFileInList = { name: file, path: fullPath, type: 'file' };
        };

        div.ondblclick = () => {
            document.getElementById('status').innerText = "Статус: Чтение файла...";
            socket.emit('read-file', fullPath);
        };
        
        container.appendChild(div);
    });
}

// --- ЛОГИКА НОВЫХ ОПЕРАЦИЙ НА ФРОНТЕНДЕ ---

function createNewItem(type) {
    const name = prompt(`Введите имя нового ${type === 'file' ? 'файла' : 'папки'}:`);
    if (!name || name.trim() === "") return;

    let targetPath = currentActivePath === "/" ? "/" + name.trim() : currentActivePath.replace(/\/$/, "") + "/" + name.trim();
    
    document.getElementById('status').innerText = "Статус: Создание объекта...";
    socket.emit('create-item', { type, path: targetPath });
}

function renameCurrentItem() {
    // Если в списке ничего не выбрано, переименовываем текущую открытую папку из селекта
    let isFolderMode = false;
    let oldName = "";
    let oldFullPath = "";

    if (selectedFileInList) {
        oldName = selectedFileInList.name;
        oldFullPath = selectedFileInList.path;
    } else {
        // Если файл не выбран, берем текущую папку
        isFolderMode = true;
        let segments = currentActivePath.split('/').filter(Boolean);
        if (segments.length === 0) return alert("Нельзя переименовать корневой каталог /");
        oldName = segments[segments.length - 1];
        oldFullPath = currentActivePath;
    }

    const newName = prompt(`Переименовать "${oldName}" в:`, oldName);
    if (!newName || newName.trim() === "" || newName === oldName) return;

    let parentDir = oldFullPath.substring(0, oldFullPath.lastIndexOf('/'));
    if (parentDir === "") parentDir = "/";
    let newFullPath = parentDir === "/" ? "/" + newName.trim() : parentDir.replace(/\/$/, "") + "/" + newName.trim();

    document.getElementById('status').innerText = "Статус: Переименование...";
    socket.emit('rename-item', { oldPath: oldFullPath, newPath: newFullPath });
    
    // Если переименовали текущую рабочую папку, обновляем указатель пути
    if (isFolderMode) {
        currentActivePath = newFullPath;
    }
}

function deleteCurrentItem() {
    let type = 'file';
    let targetPath = "";
    let name = "";
    let isFolderMode = false;

    if (selectedFileInList) {
        name = selectedFileInList.name;
        targetPath = selectedFileInList.path;
    } else {
        isFolderMode = true;
        type = 'folder';
        let segments = currentActivePath.split('/').filter(Boolean);
        if (segments.length === 0) return alert("Нельзя удалить корневой каталог /");
        name = segments[segments.length - 1];
        targetPath = currentActivePath;
    }

    if (!confirm(`Вы уверены, что хотите НАВСЕГДА удалить ${type === 'file' ? 'файл' : 'папку'} "${name}"?`)) return;

    document.getElementById('status').innerText = "Статус: Удаление объекта...";
    socket.emit('delete-item', { type, path: targetPath });

    if (isFolderMode) {
        // Если удалили текущую папку, смещаем пользователя на уровень выше
        let segments = currentActivePath.split('/').filter(Boolean);
        segments.pop();
        currentActivePath = "/" + segments.join('/');
    }
}

// Слушаем результаты выполнения операций файлового менеджера
socket.on('file-operation-result', (result) => {
    if (result.success) {
        document.getElementById('status').innerText = "Статус: Операция выполнена";
        // Обновляем текущую директорию в интерфейсе
        socket.emit('get-dir', currentActivePath);
    } else {
        alert("Ошибка файловой операции: " + result.error);
        document.getElementById('status').innerText = "Статус: Ошибка";
    }
});

socket.on('file-content', (data) => {
    if (data.success) {
        currentOpenedFilePath = data.path;
        document.getElementById('current-file-title').innerText = "Редактор: " + data.path;
        document.getElementById('code-editor').value = data.content;
        document.getElementById('status').innerText = "Статус: Файл открыт";
    } else {
        alert("Ошибка чтения файла: " + data.error);
    }
});

function saveFile() {
    if (!currentOpenedFilePath) return;
    document.getElementById('status').innerText = "Статус: Сохранение...";
    socket.emit('save-file', {
        path: currentOpenedFilePath,
        content: document.getElementById('code-editor').value
    });
}

socket.on('save-status', (data) => {
    if (data.success) document.getElementById('status').innerText = "Статус: Сохранено успешно!";
    else alert("Ошибка сохранения: " + data.error);
});

function fitTerminal() {
    try {
        fitAddon.fit();
        socket.emit('terminal-resize', { cols: term.cols, rows: term.rows });
    } catch (e) {}
}

function toggleTerminalWindow() {
    const win = document.getElementById('window-terminal');
    const btn = document.getElementById('term-toggle-btn');
    if (win.style.display === 'none') {
        win.style.display = 'flex';
        btn.innerText = "📺 Скрыть терминал";
        setTimeout(fitTerminal, 50);
    } else {
        win.style.display = 'none';
        btn.innerText = "📺 Открыть терминал";
    }
}

function makeElementDraggable(elmnt) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    const header = document.getElementById(elmnt.id + "-header");
    if (header) header.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        if(e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        pos3 = e.clientX; pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
        pos3 = e.clientX; pos4 = e.clientY;
        let newTop = elmnt.offsetTop - pos2;
        let newLeft = elmnt.offsetLeft - pos1;
        if (newTop < 50) newTop = 50;
        elmnt.style.top = newTop + "px"; elmnt.style.left = newLeft + "px";
    }

    function closeDragElement() {
        document.onmouseup = null; document.onmousemove = null;
    }
}
