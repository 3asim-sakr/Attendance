body {
    font-family: 'Cairo', sans-serif;
    background-color: #f8fafc;
}

/* Prevent iOS Safari from auto-zooming on inputs smaller than 16px */
@media screen and (max-width: 768px) {
    input,
    select,
    textarea {
        font-size: 16px !important;
    }
}

/* Custom Scrollbar */
::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}

::-webkit-scrollbar-track {
    background: #f1f5f9;
}

::-webkit-scrollbar-thumb {
    background: #cbd5e1;
    border-radius: 9999px;
}

::-webkit-scrollbar-thumb:hover {
    background: #94a3b8;
}

/* QR Code Container Styling */
#qrcode img,
#modal-qrcode img {
    margin: 0 auto;
    border-radius: 12px;
    padding: 12px;
    background: #ffffff;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
}

/* Scanner Override Styles */
#reader {
    border: none !important;
    border-radius: 16px;
    overflow: hidden;
}

#reader video {
    border-radius: 16px;
    object-fit: cover;
}

#reader__dashboard_section_csr button {
    background-color: #2563eb !important;
    color: #ffffff !important;
    padding: 8px 16px !important;
    border-radius: 10px !important;
    font-family: 'Cairo', sans-serif !important;
    font-weight: 600 !important;
    border: none !important;
    margin-top: 8px !important;
}

/* Live Sync Dot Pulse Animation */
@keyframes pulse-ring {
    0% {
        transform: scale(0.95);
        opacity: 0.8;
    }
    70% {
        transform: scale(1.15);
        opacity: 0;
    }
    100% {
        transform: scale(0.95);
        opacity: 0;
    }
}

.live-dot::before {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 9999px;
    background-color: #10b981;
    animation: pulse-ring 1.8s infinite;
}
