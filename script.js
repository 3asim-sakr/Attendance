// ==========================================
// 1. CONSTANTS & STATE MANAGEMENT
// ==========================================
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwpb0fq6loG5mXKVSnuqn03XuGL4TuqYkX3wermYlEAmGkNZnqQssswX8D7y3bB7W__Bw/exec';

const COURSES = [
    { id: 'python', name: 'بايثون (Python)', code: 'PY' },
    { id: 'english', name: 'إنجليزي (English)', code: 'EN' },
    { id: 'is', name: 'انفورميشن سيستم (Information Systems)', code: 'IS' },
    { id: 'it', name: 'انفورميشن تكنولوجي (Information Technology)', code: 'IT' },
    { id: 'statistics', name: 'ستاتيستيكس (Statistics)', code: 'ST' },
    { id: 'math', name: 'ماث (Mathematics)', code: 'MA' }
];

const SECTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

let selectedDoctorCourse = null;
let doctorSession = null;
let attendanceRecords = [];
let openSessionsList = [];
let html5QrcodeScanner = null;
let isScannerStarting = false;
let isScannerRunning = false;
let pendingScannerStop = false;
let isSubmitting = false;
let doctorPollTimer = null;

// ==========================================
// 2. PAGE DETECTION & INITIALIZATION
// ==========================================
function isDoctorPage() {
    return Boolean(document.getElementById('doctor-subject-gate-wrapper'));
}

function isStudentPage() {
    return Boolean(document.getElementById('student-view'));
}

function isApiConfigured() {
    return GOOGLE_SCRIPT_URL && !GOOGLE_SCRIPT_URL.includes('YOUR_GOOGLE_APPS_SCRIPT');
}

function getCourseCodeByName(courseName) {
    const found = COURSES.find(c => c.name === courseName);
    return found ? found.code : courseName;
}

function getCourseNameByCode(courseCode) {
    const found = COURSES.find(c => c.code === courseCode || c.name === courseCode);
    return found ? found.name : null;
}

function buildQRPayload(session) {
    const courseCode = getCourseCodeByName(session.course);
    return `UNI1|${session.sessionId}|${courseCode}|${session.section}|${session.pin}`;
}

function parseQRPayload(rawText) {
    const text = String(rawText || '').trim();

    if (text.startsWith('UNI1|')) {
        const parts = text.split('|');
        if (parts.length !== 5) return null;

        const [, sessionId, courseCode, section, pin] = parts;
        const courseName = getCourseNameByCode(courseCode);
        if (!sessionId || !courseName || !section || !pin) return null;

        return {
            app: 'UNI_ATTENDANCE',
            sessionId,
            course: courseName,
            section: String(section),
            pin: String(pin).toUpperCase()
        };
    }

    const payload = JSON.parse(text);
    if (
        !payload ||
        typeof payload !== 'object' ||
        payload.app !== 'UNI_ATTENDANCE' ||
        !payload.sessionId ||
        !payload.course ||
        !payload.section ||
        !payload.pin
    ) {
        return null;
    }

    return {
        app: 'UNI_ATTENDANCE',
        sessionId: payload.sessionId,
        course: payload.course,
        section: String(payload.section),
        pin: String(payload.pin).toUpperCase()
    };
}

function checkInAppBrowserWarning() {
    const banner = document.getElementById('inapp-browser-warning');
    if (!banner) return;

    const ua = navigator.userAgent || '';
    const isInApp = /FBAN|FBAV|Instagram|WhatsApp|Telegram|Line\/|Snapchat|Twitter|; wv\)/i.test(ua);
    if (isInApp) {
        banner.classList.remove('hidden');
    }
}

document.addEventListener('click', (event) => {
    const subjectBtn = event.target.closest('.subject-select-btn[data-course]');
    if (!subjectBtn) return;
    const courseName = subjectBtn.getAttribute('data-course');
    if (courseName) {
        enterDoctorSubject(courseName);
    }
});

window.addEventListener('DOMContentLoaded', () => {
    populateDropdowns();
    bindLifecycleAndShortcuts();

    if (!isApiConfigured()) {
        showToast('تنبيه: لم يتم إضافة رابط Google Apps Script في ملف script.js بعد!', 'error');
    }

    if (isDoctorPage()) {
        showSubjectGate();
    } else if (isStudentPage()) {
        checkInAppBrowserWarning();
        updateStudentSessionHelper();
        syncStudentSessionsFromCloud();
    }
});

function populateDropdowns() {
    const courseSelects = [
        document.getElementById('student-course')
    ].filter(Boolean);

    COURSES.forEach(course => {
        courseSelects.forEach(selectEl => {
            if (!Array.from(selectEl.options).some(o => o.value === course.name)) {
                selectEl.add(new Option(course.name, course.name));
            }
        });
    });

    const sectionSelects = [
        document.getElementById('prof-section'),
        document.getElementById('student-section'),
        document.getElementById('filter-section')
    ].filter(Boolean);

    SECTIONS.forEach(num => {
        const label = `سيكشن ${num}`;
        sectionSelects.forEach(selectEl => {
            if (!Array.from(selectEl.options).some(o => o.value === String(num))) {
                selectEl.add(new Option(label, String(num)));
            }
        });
    });
}

function bindLifecycleAndShortcuts() {
    const pinInput = document.getElementById('student-pin-input');
    if (pinInput) {
        pinInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submitWithPIN();
            }
        });
    }

    const studentCourseSelect = document.getElementById('student-course');
    const studentSectionSelect = document.getElementById('student-section');
    if (studentCourseSelect) {
        studentCourseSelect.addEventListener('change', updateStudentSessionHelper);
    }
    if (studentSectionSelect) {
        studentSectionSelect.addEventListener('change', updateStudentSessionHelper);
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeProjectorModal();
            closeClearConfirmModal();
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopCameraScanner();
        } else if (isDoctorPage() && selectedDoctorCourse) {
            syncDoctorFromCloud(false);
        } else if (isStudentPage()) {
            syncStudentSessionsFromCloud();
        }
    });

    window.addEventListener('pagehide', stopCameraScanner);
}

// ==========================================
// 3. CLOUD SYNC (GOOGLE SHEETS API)
// ==========================================
async function apiGet(paramsObj = {}) {
    const query = new URLSearchParams({ ...paramsObj, t: String(Date.now()) });
    const url = `${GOOGLE_SCRIPT_URL}?${query.toString()}`;
    const response = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (!response.ok) throw new Error('Network response failed');
    return response.json();
}

async function apiPost(bodyObj) {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(bodyObj)
    });
    if (!response.ok) throw new Error('Network response failed');
    return response.json();
}

async function syncStudentSessionsFromCloud() {
    if (!isApiConfigured()) return;
    try {
        const res = await apiGet({ action: 'getSessions' });
        if (res.status === 'ok' && Array.isArray(res.openSessions)) {
            openSessionsList = res.openSessions;
            updateStudentSessionHelper();
        }
    } catch (e) {
        // Silent fail; student can still scan QR directly
    }
}

async function syncDoctorFromCloud(isInitial = false) {
    if (!isApiConfigured() || !selectedDoctorCourse) return;
    const requestedCourse = selectedDoctorCourse;

    try {
        const prevIds = new Set(attendanceRecords.map(r => r.id));
        const [recordsRes, sessionsRes] = await Promise.all([
            apiGet({ action: 'getAll', course: requestedCourse }),
            apiGet({ action: 'getSessions' })
        ]);

        if (selectedDoctorCourse !== requestedCourse) return;

        if (sessionsRes.status === 'ok' && Array.isArray(sessionsRes.openSessions)) {
            openSessionsList = sessionsRes.openSessions;

            // Restore an active session if this course/section is currently open on the server
            if (!doctorSession) {
                const sectionSelect = document.getElementById('prof-section');
                const chosenSection = sectionSelect ? String(sectionSelect.value) : '';
                const matched =
                    openSessionsList.find(
                        s => s.course === requestedCourse && String(s.section) === chosenSection
                    ) || openSessionsList.find(s => s.course === requestedCourse);

                if (matched) {
                    doctorSession = matched;
                    if (sectionSelect) sectionSelect.value = String(matched.section);
                    updateDoctorSessionUI(false);
                }
            } else {
                const stillOpen = openSessionsList.some(
                    s => s.sessionId === doctorSession.sessionId
                );
                if (!stillOpen) {
                    doctorSession = null;
                    updateDoctorSessionUI(true);
                }
            }
        }

        if (recordsRes.status === 'ok' && Array.isArray(recordsRes.records)) {
            const newEntries = recordsRes.records.filter(r => !prevIds.has(r.id));
            attendanceRecords = recordsRes.records;
            renderAttendanceTable();
            updateDashboardStats();

            if (!isInitial && newEntries.length > 0) {
                const latestName = newEntries[0].studentName;
                const extra = newEntries.length > 1 ? ` (+${newEntries.length - 1} آخرين)` : '';
                showToast(`تم تسجيل حضور: ${latestName}${extra}`, 'success');
            }
        }
    } catch (e) {
        console.error('Cloud sync error:', e);
    }
}

function startDoctorPolling() {
    stopDoctorPolling();
    doctorPollTimer = setInterval(() => {
        if (!document.hidden && selectedDoctorCourse) {
            syncDoctorFromCloud(false);
        }
    }, 5000);
}

function stopDoctorPolling() {
    if (doctorPollTimer) {
        clearInterval(doctorPollTimer);
        doctorPollTimer = null;
    }
}

// ==========================================
// 4. DOCTOR SUBJECT GATE & LOGOUT RESET
// ==========================================
function showSubjectGate() {
    const gateWrapper = document.getElementById('doctor-subject-gate-wrapper');
    const dashboard = document.getElementById('doctor-dashboard-wrapper');
    if (dashboard) dashboard.classList.add('hidden');
    if (gateWrapper) gateWrapper.classList.remove('hidden');
}

function enterDoctorSubject(courseName) {
    populateDropdowns();

    selectedDoctorCourse = courseName;
    doctorSession = null;
    attendanceRecords = [];

    const headerCourseEl = document.getElementById('header-selected-course');
    const panelCourseEl = document.getElementById('panel-course-name');
    const profSectionEl = document.getElementById('prof-section');
    const filterSectionEl = document.getElementById('filter-section');
    const filterSearchEl = document.getElementById('filter-search');

    if (headerCourseEl) headerCourseEl.textContent = courseName;
    if (panelCourseEl) panelCourseEl.textContent = courseName;
    if (profSectionEl) profSectionEl.value = '1';
    if (filterSectionEl) filterSectionEl.value = 'ALL';
    if (filterSearchEl) filterSearchEl.value = '';

    updateDoctorSessionUI(false);
    updateDashboardStats();
    renderAttendanceTable();

    const gateWrapper = document.getElementById('doctor-subject-gate-wrapper');
    const dashboard = document.getElementById('doctor-dashboard-wrapper');
    if (gateWrapper) gateWrapper.classList.add('hidden');
    if (dashboard) dashboard.classList.remove('hidden');

    syncDoctorFromCloud(true);
    startDoctorPolling();
}

async function logoutDoctor() {
    // Switching back to subject selection keeps active sessions open so multiple sessions can run simultaneously.
    stopDoctorPolling();
    closeProjectorModal();
    closeClearConfirmModal();

    selectedDoctorCourse = null;
    doctorSession = null;
    attendanceRecords = [];

    const qrEl = document.getElementById('qrcode');
    if (qrEl) qrEl.innerHTML = '';
    const tbody = document.getElementById('attendance-tbody');
    if (tbody) tbody.innerHTML = '';

    showSubjectGate();
    showToast('تم العودة لاختيار المواد مع الإبقاء على الجلسات النشطة مفتوحة', 'info');
}

// ==========================================
// 5. PROFESSOR LOGIC (QR GENERATION, STOP & TABLE)
// ==========================================
async function copyStudentPageLink() {
    const studentUrl = new URL('index.html', window.location.href).href;
    await copyTextToClipboard(studentUrl, 'تم نسخ رابط صفحة تسجيل حضور الطلاب');
}

function generatePIN() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let pin = '';
    for (let i = 0; i < 5; i++) {
        pin += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return pin;
}

async function generateSessionQR() {
    if (!isDoctorPage() || !selectedDoctorCourse) return;

    const section = String(document.getElementById('prof-section').value);
    const pin = generatePIN();

    // Reuse existing open session for the exact same course + section if already active, otherwise create a new one
    const existingSameSlot = openSessionsList.find(
        s => s.course === selectedDoctorCourse && String(s.section) === section
    );

    const sessionId = existingSameSlot
        ? existingSameSlot.sessionId
        : `SES-${getCourseCodeByName(selectedDoctorCourse)}-S${section}-${Date.now()}`;

    doctorSession = {
        sessionId,
        course: selectedDoctorCourse,
        section,
        pin,
        createdAt: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
    };

    // Update local open sessions list without closing sessions for other courses/sections
    openSessionsList = [
        ...openSessionsList.filter(s => s.sessionId !== sessionId),
        doctorSession
    ];

    updateDoctorSessionUI(false);
    updateDashboardStats();

    document.getElementById('filter-section').value = section;
    renderAttendanceTable();

    if (!isApiConfigured()) {
        showToast('تم توليد الكود محلياً، لكن رابط Google Sheets غير مضاف!', 'error');
        return;
    }

    try {
        const res = await apiPost({ action: 'setSession', session: doctorSession });
        if (res.status === 'ok') {
            showToast(`تم فتح جلسة ${selectedDoctorCourse} - سيكشن ${section}`, 'success');
        } else {
            showToast('فشل حفظ الجلسة في Google Sheets: ' + (res.message || ''), 'error');
        }
    } catch (e) {
        showToast('تعذر الاتصال بـ Google Sheets. تحقق من الإنترنت وصلاحيات النشر.', 'error');
    }
}

async function stopCurrentSession() {
    if (!doctorSession) return;

    const stoppedSession = doctorSession;
    doctorSession = null;
    openSessionsList = openSessionsList.filter(s => s.sessionId !== stoppedSession.sessionId);
    closeProjectorModal();

    updateDoctorSessionUI(true);
    updateDashboardStats();

    if (isApiConfigured()) {
        try {
            const res = await apiPost({ action: 'stopSession', sessionId: stoppedSession.sessionId });
            if (res.status === 'ok') {
                showToast(`تم إيقاف جلسة سيكشن ${stoppedSession.section} ولن يُقبل أي تسجيل جديد`, 'info');
            } else {
                showToast('تم إيقاف الجلسة محلياً، تعذر التحديث في Google Sheets', 'error');
            }
        } catch (e) {
            showToast('تعذر الاتصال بـ Google Sheets لإيقاف الجلسة', 'error');
        }
    } else {
        showToast('تم إيقاف الجلسة محلياً', 'info');
    }
}

function updateDoctorSessionUI(wasStopped = false) {
    const qrDisplayContainer = document.getElementById('qr-display-container');
    const qrEmptyState = document.getElementById('qr-empty-state');
    const statusBadge = document.getElementById('session-status-badge');
    const stopBtn = document.getElementById('btn-stop-session');
    const emptyTitle = document.getElementById('qr-empty-title');
    const emptyDesc = document.getElementById('qr-empty-desc');

    if (!qrDisplayContainer || !qrEmptyState || !statusBadge) return;

    if (!doctorSession) {
        qrDisplayContainer.classList.add('hidden');
        qrEmptyState.classList.remove('hidden');
        if (stopBtn) stopBtn.classList.add('hidden');

        if (wasStopped) {
            statusBadge.textContent = 'تم إيقاف الجلسة';
            statusBadge.className = 'text-xs bg-rose-500 text-white px-2.5 py-1 rounded-full font-bold';
            if (emptyTitle) emptyTitle.textContent = 'تم إغلاق الجلسة وانتهى وقت التسجيل';
            if (emptyDesc) emptyDesc.textContent = 'يمكنك اختيار سيكشن آخر والضغط على زر التوليد لفتح جلسة جديدة.';
        } else {
            statusBadge.textContent = 'جاهز للبدء';
            statusBadge.className = 'text-xs bg-white/20 px-2.5 py-1 rounded-full font-semibold';
            if (emptyTitle) emptyTitle.textContent = 'لا توجد جلسة نشطة حالياً';
            if (emptyDesc) emptyDesc.textContent = 'اختر رقم السيكشن ثم اضغط على زر التوليد لعرض الـ QR Code للطلاب.';
        }
        return;
    }

    qrEmptyState.classList.add('hidden');
    qrDisplayContainer.classList.remove('hidden');
    if (stopBtn) stopBtn.classList.remove('hidden');

    const activeCount = openSessionsList.length || 1;
    statusBadge.textContent = `جلسة نشطة (${activeCount} مفتوحة)`;
    statusBadge.className = 'text-xs bg-emerald-500 text-white px-2.5 py-1 rounded-full font-bold';

    document.getElementById('qr-badge-info').textContent = `${doctorSession.course} • سيكشن ${doctorSession.section}`;
    document.getElementById('btn-pin-text').textContent = doctorSession.pin;

    const qrEl = document.getElementById('qrcode');
    qrEl.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
        new QRCode(qrEl, {
            text: buildQRPayload(doctorSession),
            width: 190,
            height: 190,
            colorDark: '#0f172a',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    } else {
        qrEl.innerHTML = '<p class="text-xs text-rose-600 font-bold">تعذر تحميل مكتبة QR Code. استخدم رمز الجلسة (PIN).</p>';
    }
}

function updateDashboardStats() {
    const totalEl = document.getElementById('stat-total-records');
    if (!totalEl) return;

    totalEl.textContent = attendanceRecords.length;
    document.getElementById('stat-active-course').textContent = selectedDoctorCourse
        ? selectedDoctorCourse.split(' ')[0]
        : '—';

    if (doctorSession) {
        const sessionCount = attendanceRecords.filter(
            rec => rec.sessionId === doctorSession.sessionId
        ).length;

        document.getElementById('stat-current-session').textContent = sessionCount;
        document.getElementById('stat-current-label').textContent = `سيكشن ${doctorSession.section}`;
        document.getElementById('stat-active-section').textContent = `سيكشن رقم ${doctorSession.section}`;
        document.getElementById('stat-session-pin').textContent = doctorSession.pin;
    } else {
        document.getElementById('stat-current-session').textContent = '0';
        document.getElementById('stat-current-label').textContent = 'لا توجد جلسة مفتوحة';
        document.getElementById('stat-active-section').textContent = 'اختر رقم السيكشن';
        document.getElementById('stat-session-pin').textContent = '----';
    }
}

function matchesActiveFilters(rec) {
    const filterSectionEl = document.getElementById('filter-section');
    const filterSearchEl = document.getElementById('filter-search');

    const filterSection = filterSectionEl ? filterSectionEl.value : 'ALL';
    const searchQuery = filterSearchEl ? filterSearchEl.value.trim().toLowerCase() : '';

    const matchCourse = !selectedDoctorCourse || rec.course === selectedDoctorCourse;
    const matchSection = filterSection === 'ALL' || String(rec.section) === String(filterSection);
    const matchSearch = !searchQuery || rec.studentName.toLowerCase().includes(searchQuery);
    return matchCourse && matchSection && matchSearch;
}

function getFilteredRecords() {
    return attendanceRecords.filter(matchesActiveFilters);
}

function createAttendanceRowElement(rec, rowNumber) {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-blue-50/40 transition-colors';
    tr.innerHTML = `
        <td class="row-index py-3.5 px-4 font-bold text-slate-400 text-xs">${rowNumber}</td>
        <td class="py-3.5 px-4 font-bold text-slate-900">${escapeHTML(rec.studentName)}</td>
        <td class="py-3.5 px-4">
            <span class="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-bold">${escapeHTML(rec.course)}</span>
        </td>
        <td class="py-3.5 px-4 font-bold text-slate-700 text-xs">سيكشن ${escapeHTML(rec.section)}</td>
        <td class="py-3.5 px-4 text-xs text-slate-500 font-semibold">${escapeHTML(rec.timestamp)}</td>
        <td class="py-3.5 px-4 text-center">
            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-extrabold">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-600"></span>
                حاضر
            </span>
        </td>
    `;
    return tr;
}

function renderAttendanceTable() {
    const tbody = document.getElementById('attendance-tbody');
    const emptyState = document.getElementById('table-empty-state');
    if (!tbody || !emptyState) return;

    const filtered = getFilteredRecords();
    tbody.innerHTML = '';

    if (filtered.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    const fragment = document.createDocumentFragment();
    filtered.forEach((rec, idx) => {
        fragment.appendChild(createAttendanceRowElement(rec, filtered.length - idx));
    });
    tbody.appendChild(fragment);
}

function openProjectorModal() {
    if (!doctorSession) return;
    document.getElementById('modal-course-title').textContent = doctorSession.course;
    document.getElementById('modal-section-subtitle').textContent = `سيكشن رقم ${doctorSession.section}`;
    document.getElementById('modal-pin-code').textContent = doctorSession.pin;

    const modalQr = document.getElementById('modal-qrcode');
    modalQr.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
        new QRCode(modalQr, {
            text: buildQRPayload(doctorSession),
            width: 260,
            height: 260,
            colorDark: '#0f172a',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    }

    document.getElementById('projector-modal').classList.remove('hidden');
}

function closeProjectorModal() {
    const modal = document.getElementById('projector-modal');
    if (modal) modal.classList.add('hidden');
}

function handleBackdropClose(event, modalId) {
    if (event.target.id === modalId) {
        document.getElementById(modalId).classList.add('hidden');
    }
}

async function copySessionPIN() {
    if (!doctorSession) return;
    await copyTextToClipboard(doctorSession.pin, `تم نسخ رمز الجلسة (${doctorSession.pin})`);
}

async function copyTextToClipboard(text, successMessage) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const tempInput = document.createElement('textarea');
            tempInput.value = text;
            tempInput.style.position = 'fixed';
            tempInput.style.opacity = '0';
            document.body.appendChild(tempInput);
            tempInput.focus();
            tempInput.select();
            document.execCommand('copy');
            document.body.removeChild(tempInput);
        }
        showToast(successMessage, 'success');
    } catch (err) {
        showToast('تعذر النسخ تلقائياً: ' + text, 'info');
    }
}

function formatCSVCell(value) {
    let str = String(value ?? '').replace(/"/g, '""');
    if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
    }
    return `"${str}"`;
}

function exportToCSV() {
    const recordsToExport = getFilteredRecords();

    if (recordsToExport.length === 0) {
        showToast('لا توجد سجلات مطابقة لتصديرها حالياً', 'error');
        return;
    }

    const headers = ['م', 'اسم الطالب', 'المادة الدراسية', 'السيكشن', 'وقت التسجيل', 'الحالة'];
    const rows = recordsToExport.map((r, i) => [
        i + 1,
        formatCSVCell(r.studentName),
        formatCSVCell(r.course),
        formatCSVCell(`سيكشن ${r.section}`),
        formatCSVCell(r.timestamp),
        formatCSVCell('حاضر')
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const courseTag = getCourseCodeByName(selectedDoctorCourse || 'ALL');
    link.download = `كشف_حضور_${courseTag}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast(`تم تحميل ملف كشف الحضور (${recordsToExport.length} سجل)`, 'success');
}

function openClearConfirmModal() {
    const modal = document.getElementById('clear-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeClearConfirmModal() {
    const modal = document.getElementById('clear-modal');
    if (modal) modal.classList.add('hidden');
}

async function confirmClearRecords() {
    closeClearConfirmModal();
    if (!selectedDoctorCourse) return;

    attendanceRecords = [];
    renderAttendanceTable();
    updateDashboardStats();

    if (isApiConfigured()) {
        try {
            await apiPost({ action: 'clearRecords', course: selectedDoctorCourse });
            showToast(`تم مسح سجلات مادة ${selectedDoctorCourse} من Google Sheets`, 'info');
        } catch (e) {
            showToast('تم المسح محلياً، تعذر الاتصال بـ Google Sheets', 'error');
        }
    } else {
        showToast('تم مسح السجلات محلياً', 'info');
    }
}

// ==========================================
// 6. STUDENT LOGIC (SCANNER & MULTI-SESSION CHECK-IN)
// ==========================================
function getMatchingOpenSessionForStudent() {
    const courseEl = document.getElementById('student-course');
    const sectionEl = document.getElementById('student-section');
    if (!courseEl || !sectionEl) return null;

    const course = courseEl.value;
    const section = String(sectionEl.value);
    return openSessionsList.find(s => s.course === course && String(s.section) === section) || null;
}

function updateStudentSessionHelper() {
    const helperBanner = document.getElementById('active-session-helper');
    const helperName = document.getElementById('helper-session-name');
    if (!helperBanner || !helperName) return;

    const matching = getMatchingOpenSessionForStudent();
    if (matching) {
        helperBanner.classList.remove('hidden');
        helperName.textContent = `${matching.course} (سيكشن ${matching.section})`;
    } else {
        helperBanner.classList.add('hidden');
    }
}

function validateStudentInputs() {
    const rawName = document.getElementById('student-name').value;
    const cleanName = rawName.replace(/\s+/g, ' ').trim();
    const course = document.getElementById('student-course').value;
    const section = document.getElementById('student-section').value;

    const words = cleanName.split(' ').filter(Boolean);
    const hasLetters = /[\u0600-\u06FFa-zA-Z]/.test(cleanName);

    if (!hasLetters || cleanName.length < 5 || words.length < 2) {
        showToast('يرجى إدخال اسم الطالب ثلاثي بشكل صحيح', 'error');
        return null;
    }

    return { name: cleanName, course, section };
}

function startCameraScanner() {
    const studentData = validateStudentInputs();
    if (!studentData) return;

    if (!window.isSecureContext) {
        showToast('تشغيل الكاميرا يتطلب رابط HTTPS آمن. استخدم رمز الجلسة (PIN) بالأسفل.', 'error');
        return;
    }

    if (typeof Html5Qrcode === 'undefined') {
        showToast('مكتبة الكاميرا غير متوفرة حالياً. استخدم رمز الجلسة (PIN) بالأسفل.', 'error');
        return;
    }

    if (isScannerStarting || isScannerRunning || isSubmitting) return;

    const wrapper = document.getElementById('scanner-wrapper');
    const btnStart = document.getElementById('btn-start-scan');
    wrapper.classList.remove('hidden');
    btnStart.classList.add('hidden');

    isScannerStarting = true;
    pendingScannerStop = false;

    const scannerConfig = {
        verbose: false,
        useBarCodeDetectorIfSupported: true
    };
    if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
        scannerConfig.formatsToSupport = [Html5QrcodeSupportedFormats.QR_CODE];
    }

    html5QrcodeScanner = new Html5Qrcode('reader', scannerConfig);

    const scanOptions = {
        fps: 8,
        qrbox: { width: 220, height: 220 },
        videoConstraints: {
            facingMode: 'environment',
            width: { ideal: 640 },
            height: { ideal: 480 }
        }
    };

    const onScanSuccess = (decodedText) => {
        stopCameraScanner();
        processScannedQR(decodedText);
    };

    const onStartSuccess = () => {
        isScannerStarting = false;
        isScannerRunning = true;

        if (pendingScannerStop) {
            pendingScannerStop = false;
            stopCameraScanner();
        }
    };

    const onStartFailure = () => {
        isScannerStarting = false;
        isScannerRunning = false;
        pendingScannerStop = false;
        html5QrcodeScanner = null;
        wrapper.classList.add('hidden');
        btnStart.classList.remove('hidden');
        showToast('تعذر فتح الكاميرا. يمكنك استخدام رمز الجلسة (PIN) بالأسفل.', 'error');
    };

    html5QrcodeScanner
        .start({ facingMode: 'environment' }, scanOptions, onScanSuccess, () => {})
        .then(onStartSuccess)
        .catch(() => {
            if (!html5QrcodeScanner || pendingScannerStop) {
                onStartFailure();
                return;
            }
            const fallbackOptions = {
                fps: 8,
                qrbox: { width: 220, height: 220 },
                videoConstraints: {
                    facingMode: 'user',
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                }
            };
            html5QrcodeScanner
                .start({ facingMode: 'user' }, fallbackOptions, onScanSuccess, () => {})
                .then(onStartSuccess)
                .catch(onStartFailure);
        });
}

function stopCameraScanner() {
    const wrapper = document.getElementById('scanner-wrapper');
    const btnStart = document.getElementById('btn-start-scan');
    if (wrapper) wrapper.classList.add('hidden');
    if (btnStart) btnStart.classList.remove('hidden');

    if (isScannerStarting) {
        pendingScannerStop = true;
        return;
    }

    if (html5QrcodeScanner && isScannerRunning) {
        const scannerInstance = html5QrcodeScanner;
        html5QrcodeScanner = null;
        isScannerRunning = false;

        scannerInstance.stop().then(() => {
            scannerInstance.clear();
        }).catch(() => {});
    }
}

function processScannedQR(rawText) {
    try {
        const payload = parseQRPayload(rawText);
        if (!payload) {
            showToast('كود QR غير صالح لهذا النظام!', 'error');
            return;
        }
        finalizeStudentCheckIn(payload);
    } catch (e) {
        showToast('كود QR غير مقروء أو غير تابع للجامعة', 'error');
    }
}

async function submitWithPIN() {
    const studentData = validateStudentInputs();
    if (!studentData) return;

    const enteredPin = document.getElementById('student-pin-input').value.trim().toUpperCase();
    if (!enteredPin) {
        showToast('يرجى إدخال رمز الجلسة (PIN) المعروض عند الدكتور', 'error');
        return;
    }

    let matching = openSessionsList.find(
        s => s.course === studentData.course &&
             String(s.section) === String(studentData.section) &&
             s.pin.toUpperCase() === enteredPin
    );

    if (!matching && isApiConfigured()) {
        await syncStudentSessionsFromCloud();
        matching = openSessionsList.find(
            s => s.course === studentData.course &&
                 String(s.section) === String(studentData.section) &&
                 s.pin.toUpperCase() === enteredPin
        );
    }

    finalizeStudentCheckIn({
        sessionId: matching ? matching.sessionId : '',
        course: studentData.course,
        section: String(studentData.section),
        pin: enteredPin
    });
}

function quickAutoScanActiveSession() {
    const matching = getMatchingOpenSessionForStudent();
    if (!matching) {
        showToast('لا توجد جلسة نشطة لهذه المادة وهذا السيكشن حالياً!', 'error');
        return;
    }

    const studentData = validateStudentInputs();
    if (!studentData) return;

    finalizeStudentCheckIn(matching);
}

async function finalizeStudentCheckIn(sessionPayload) {
    if (isSubmitting) return;

    const studentData = validateStudentInputs();
    if (!studentData) return;

    if (
        studentData.course !== sessionPayload.course ||
        String(studentData.section) !== String(sessionPayload.section)
    ) {
        showToast(
            `خطأ: الكود الخاص بالدكتور هو لمادة (${sessionPayload.course} - سيكشن ${sessionPayload.section}) وليس لاختيارك!`,
            'error'
        );
        return;
    }

    if (!isApiConfigured()) {
        showToast('خطأ في الإعداد: رابط Google Sheets غير مضاف في script.js', 'error');
        return;
    }

    isSubmitting = true;
    showToast('جاري تسجيل حضورك في كشف الدكتور...', 'info');

    try {
        const res = await apiPost({
            action: 'checkIn',
            sessionId: sessionPayload.sessionId || '',
            pin: sessionPayload.pin,
            studentName: studentData.name,
            course: studentData.course,
            section: String(studentData.section)
        });

        if (res.status !== 'ok' || !res.record) {
            showToast(res.message || 'تعذر تسجيل الحضور، حاول مرة أخرى.', 'error');
            return;
        }

        const newRecord = res.record;

        document.getElementById('receipt-name').textContent = newRecord.studentName;
        document.getElementById('receipt-course').textContent = newRecord.course;
        document.getElementById('receipt-section').textContent = `سيكشن ${newRecord.section}`;
        document.getElementById('receipt-time').textContent = newRecord.timestamp;

        document.getElementById('student-form-card').classList.add('hidden');
        document.getElementById('student-receipt-card').classList.remove('hidden');

        showToast('تم تسجيل حضورك وإرساله للدكتور بنجاح!', 'success');
    } catch (e) {
        showToast('خطأ في الاتصال بالإنترنت. تأكد من الشبكة وحاول مرة أخرى.', 'error');
    } finally {
        isSubmitting = false;
    }
}

function resetStudentForm() {
    document.getElementById('student-name').value = '';
    document.getElementById('student-pin-input').value = '';
    document.getElementById('student-receipt-card').classList.add('hidden');
    document.getElementById('student-form-card').classList.remove('hidden');
}

// ==========================================
// 7. UTILITIES (TOASTS & SANITIZATION)
// ==========================================
function getToastIconSVG(type) {
    if (type === 'success') {
        return '<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    }
    if (type === 'error') {
        return '<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>';
    }
    return '<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');

    const colors = {
        success: 'bg-emerald-600 text-white border-emerald-700',
        error: 'bg-rose-600 text-white border-rose-700',
        info: 'bg-slate-800 text-white border-slate-900'
    };

    toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-lg border text-xs font-bold transition-all duration-300 transform translate-y-0 ${colors[type] || colors.info}`;
    toast.innerHTML = `
        ${getToastIconSVG(type)}
        <span class="leading-relaxed">${escapeHTML(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
