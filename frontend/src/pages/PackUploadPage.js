import React, { useState } from 'react';
import '../App.css';
import config from '../config';

const PackUploadPage = () => {
    const [file, setFile] = useState(null);
    const [uploadStatus, setUploadStatus] = useState('');
    const [error, setError] = useState('');
    const [uploadProgress, setUploadProgress] = useState(0);
    const [isUploading, setIsUploading] = useState(false);

    const handleFileChange = (event) => {
        const selectedFile = event.target.files[0];
        if (selectedFile && selectedFile.type === 'application/json') {
            setFile(selectedFile);
            setError('');
            setUploadProgress(0);
        } else {
            setError('Please select a valid JSON file');
            setFile(null);
            setUploadProgress(0);
        }
    };

    const handleUpload = async () => {
        if (!file) {
            setError('Please select a file first');
            return;
        }

        setIsUploading(true);
        setUploadProgress(0);
        setError('');
        setUploadStatus('');

        try {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const jsonData = JSON.parse(e.target.result);
                    
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', `${config.apiUrl}/api/pack/upload`, true);
                    xhr.setRequestHeader('Content-Type', 'application/json');

                    xhr.upload.onprogress = (event) => {
                        if (event.lengthComputable) {
                            const progress = Math.round((event.loaded * 100) / event.total);
                            setUploadProgress(progress);
                        }
                    };

                    xhr.onload = () => {
                        if (xhr.status === 200) {
                            setUploadStatus('Pack uploaded successfully!');
                            setError('');
                        } else {
                            const result = JSON.parse(xhr.responseText);
                            setError(result.error || 'Failed to upload pack');
                            setUploadStatus('');
                        }
                        setIsUploading(false);
                    };

                    xhr.onerror = () => {
                        setError('Network error occurred');
                        setUploadStatus('');
                        setIsUploading(false);
                    };

                    xhr.send(JSON.stringify(jsonData));
                } catch (parseError) {
                    console.log(parseError);
                    setError('Invalid JSON format');
                    setUploadStatus('');
                    setIsUploading(false);
                }
            };

            reader.onerror = () => {
                setError('Error reading file');
                setUploadStatus('');
                setIsUploading(false);
            };

            reader.readAsText(file);
        } catch (error) {
            setError('Error uploading file');
            setUploadStatus('');
            setIsUploading(false);
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
                    disabled={isUploading}
                />
                <button 
                    onClick={handleUpload}
                    disabled={!file || isUploading}
                    className="upload-button"
                >
                    {isUploading ? 'Uploading...' : 'Upload Pack'}
                </button>
                {isUploading && (
                    <div className="progress-container">
                        <div 
                            className="progress-bar" 
                            style={{ width: `${uploadProgress}%` }}
                        />
                        <span className="progress-text">{uploadProgress}%</span>
                    </div>
                )}
            </div>
            {error && <div className="error-message">{error}</div>}
            {uploadStatus && <div className="success-message">{uploadStatus}</div>}
        </div>
    );
};

export default PackUploadPage; 