pipeline {
    agent any
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
        stage('Typecheck') {
            steps {
                sh 'npm run ts'
            }
        }
        stage('Build') {
            steps {
                sh 'npx electron-forge package'
            }
        }
    }
}
