import React, { useState } from 'react';
import '../App.css';
import config from '../config';


const PackUploadPage = () => {
    const [file, setFile] = useState(null);
    const [uploadStatus, setUploadStatus] = useState('');
    const [error, setError] = useState('');

    const handleFileChange = (event) => {
        const selectedFile = event.target.files[0];
        if (selectedFile && selectedFile.type === 'application/json') {
            setFile(selectedFile);
            setError('');
        } else {
            setError('Please select a valid JSON file');
            setFile(null);
        }
    };

    const handleUpload = async () => {
        if (!file) {
            setError('Please select a file first');
            return;
        }

        try {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const jsonData = JSON.parse(e.target.result);
                    const response = await fetch(`${config.apiUrl}/api/pack/upload`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(jsonData)
                    });

                    const result = await response.json();

                    if (response.ok) {
                        setUploadStatus('Pack uploaded successfully!');
                        setError('');
                    } else {
                        setError(result.error || 'Failed to upload pack');
                        setUploadStatus('');
                    }
                } catch (parseError) {
                    console.log(parseError);
                    setError('Invalid JSON format');
                    setUploadStatus('');
                }
            };

            reader.onerror = () => {
                setError('Error reading file');
                setUploadStatus('');
            };

            reader.readAsText(file);
        } catch (error) {
            setError('Error uploading file');
            setUploadStatus('');
        }
    };

    return (
        <div className="pack-upload-container">
            <h1>Upload New Pack</h1>
            <div className="upload-section">
                <input
                    type="file"
                    accept=".json"
                    onChange={handleFileChange}
                    className="file-input"
                />
                <button 
                    onClick={handleUpload}
                    disabled={!file}
                    className="upload-button"
                >
                    Upload Pack
                </button>
            </div>
            {error && <div className="error-message">{error}</div>}
            {uploadStatus && <div className="success-message">{uploadStatus}</div>}
        </div>
    );
};

export default PackUploadPage; 