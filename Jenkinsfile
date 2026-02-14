pipeline {
    agent any
    tools { nodejs 'node' }
    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        stage('Install') {
            steps {
                sh 'npm ci'
            }
        }
        stage('Build') {
            steps {
                sh 'npx electron-forge package'
            }
        }
    }
}