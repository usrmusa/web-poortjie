document.addEventListener('DOMContentLoaded', () => {
    const ratingModal = document.getElementById('rating-modal');
    let serviceId, serviceKey, currentUser;
    let allComments = [];

    // --- Main Initialization ---
    const initializeModal = () => {
        // Initial check for currentUser
        currentUser = firebase.auth().currentUser;

        // Use event delegation for the modal to handle dynamically loaded HTML
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'close-modal') closeModal();
            if (e.target.classList.contains('star')) handleStarClick(e);
            if (e.target.id === 'submit-rating') handleSubmit();
            
            // Handle Rate button click
            const rateBtn = e.target.closest('.rate-service');
            if (rateBtn) {
                const sId = rateBtn.dataset.serviceId;
                const sKey = rateBtn.dataset.serviceKey;
                window.openRatingModal(sId, sKey);
            }

            // Handle Like button click (using closest to catch icon clicks too)
            const likeBtn = e.target.closest('.like-comment-btn');
            if (likeBtn) {
                // Determine sKey and sId from attributes
                const sId = likeBtn.dataset.serviceId;
                const sKey = likeBtn.dataset.serviceKey;
                handleLikeClick(likeBtn, sId, sKey);
            }

            // Handle Comment Sort Change
            if (e.target.id === 'comment-sort') {
                renderCommentsList(allComments);
            }
        });

        // Listen for Firebase auth state changes
        firebase.auth().onAuthStateChanged(user => {
            currentUser = user;
        });
    };

    // --- Like Comment Action ---
    const handleLikeClick = async (btn, sId, sKey) => {
        // If currentUser is not yet set, try to get it from firebase.auth() directly
        if (!currentUser) {
            currentUser = firebase.auth().currentUser;
        }
        
        if (!currentUser) {
            sessionStorage.setItem('redirectUrl', window.top.location.href);
            window.top.location.replace(window.location.pathname.includes('/services/') ? '../authentication/login.html' : 'authentication/login.html');
            return;
        }

        // Prevent multiple rapid clicks
        if (btn.disabled) return;
        btn.disabled = true;

        const commentUid = btn.dataset.commentUid;

        const serviceRef = db.collection('poortjie').doc('services').collection(sKey).doc(sId);
        const likesPath = `ratings.${commentUid}.likes`;

        try {
            // Optimistic UI update
            const icon = btn.querySelector('i');
            const countSpan = btn.querySelector('.likes-count');
            let count = parseInt(countSpan.textContent);
            const isLiked = icon.classList.contains('fas'); // fas means liked (heart filled)

            if (isLiked) {
                // Unlike
                icon.className = 'far fa-heart';
                btn.classList.remove('text-red-500');
                btn.classList.add('opacity-60');
                countSpan.textContent = Math.max(0, count - 1);
                
                await serviceRef.update({
                    [`${likesPath}.${currentUser.uid}`]: firebase.firestore.FieldValue.delete()
                });
            } else {
                // Like
                icon.className = 'fas fa-heart text-red-500';
                btn.classList.add('text-red-500');
                btn.classList.remove('opacity-60');
                countSpan.textContent = count + 1;

                await serviceRef.update({
                    [`${likesPath}.${currentUser.uid}`]: true
                });
            }
        } catch (error) {
            console.error("Error toggling like:", error);
        } finally {
            btn.disabled = false;
        }
    };

    // --- Modal Control & Data Loading ---
    window.openRatingModal = async (sId, sKey) => {
        // If currentUser is not yet set, try to get it from firebase.auth() directly
        if (!currentUser) {
            currentUser = firebase.auth().currentUser;
        }

        if (!currentUser) {
            sessionStorage.setItem('redirectUrl', window.top.location.href);
            window.top.location.replace(window.location.pathname.includes('/services/') ? '../authentication/login.html' : 'authentication/login.html');
            return;
        }
        serviceId = sId;
        serviceKey = sKey;

        ratingModal.classList.remove('hidden');
        await loadDataForModal();
    };

    const loadDataForModal = async () => {
        const serviceRef = db.collection('poortjie').doc('services').collection(serviceKey).doc(serviceId);
        const doc = await serviceRef.get();

        if (!doc.exists) {
            console.error("Service provider document not found!");
            return;
        }

        const providerData = doc.data();

        // 1. Check if CURRENT USER already has a rating
        const ratingsMap = providerData.ratings || {};
        const userExistingRating = ratingsMap[currentUser.uid];

        if (userExistingRating) {
            updateStarsUI(userExistingRating.rating);
            document.getElementById('comment-input').value = userExistingRating.comment || '';
            document.getElementById('submit-rating').textContent = 'Update Your Feedback';
            document.getElementById('submit-rating').disabled = false;
        } else {
            resetUserRatingUI();
        }

        // 2. Load all comments for display (filtering out empty comments if desired)
        allComments = Object.entries(ratingsMap).map(([userId, data]) => ({
            userId,
            ...data
        }));

        renderCommentsList(allComments);
    };

    const closeModal = () => {
        ratingModal.classList.add('hidden');
        resetUserRatingUI();
    };

    // --- UI Rendering ---
    const renderCommentsList = (commentsToRender) => {
        const commentsList = document.getElementById('comments-list');
        if (!commentsList) return; // Guard if element doesn't exist in HTML

        // Sort by selected criteria
        const sortValue = document.getElementById('comment-sort')?.value || 'most-liked';
        
        const sorted = [...commentsToRender].sort((a, b) => {
            const likesA = a.likes ? Object.keys(a.likes).length : 0;
            const likesB = b.likes ? Object.keys(b.likes).length : 0;

            if (sortValue === 'most-liked') {
                if (likesB !== likesA) return likesB - likesA;
            } else if (sortValue === 'least-liked') {
                if (likesA !== likesB) return likesA - likesB;
            }

            const timeA = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
            const timeB = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
            return timeB - timeA;
        });

        commentsList.innerHTML = sorted.length > 0 ? sorted.map(c => {
            const likesCount = c.likes ? Object.keys(c.likes).length : 0;
            const isLiked = currentUser && c.likes && c.likes[currentUser.uid];
            const likeIconClass = isLiked ? 'fas fa-heart text-red-500' : 'far fa-heart';

            return `
            <div class="p-3 rounded-lg bg-slate-100 dark:bg-slate-700/50 mb-2 relative group">
                <div class="flex justify-between items-start mb-1">
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-sm">${c.userId === currentUser?.uid ? 'You' : 'Anonymous'}</span>
                        <div class="text-amber-500 text-xs">
                            ${'★'.repeat(c.rating)}${'☆'.repeat(5 - c.rating)}
                        </div>
                    </div>
                    <button class="like-comment-btn flex items-center gap-1 text-xs transition-colors hover:text-red-500 ${isLiked ? 'text-red-500' : 'opacity-60'}" 
                            data-comment-uid="${c.userId}" 
                            data-service-id="${serviceId}" 
                            data-service-key="${serviceKey}">
                        <i class="${likeIconClass}"></i>
                        <span class="likes-count">${likesCount}</span>
                    </button>
                </div>
                ${c.comment ? `<p class="text-sm text-slate-800 dark:text-slate-200 italic">"${c.comment}"</p>` : ''}
            </div>
        `;}).join('') : '<p class="text-sm text-center text-slate-500">No ratings yet.</p>';
    };

    const handleStarClick = (e) => {
        const rating = parseInt(e.target.dataset.value);
        updateStarsUI(rating);
    };

    const updateStarsUI = (rating) => {
        const stars = document.querySelectorAll('#star-rating .star');
        stars.forEach(s => {
            const val = parseInt(s.dataset.value);
            if (val <= rating) {
                s.classList.add('text-amber-500');
                s.classList.remove('text-slate-300', 'dark:text-slate-600');
            } else {
                s.classList.remove('text-amber-500');
                s.classList.add('text-slate-300', 'dark:text-slate-600');
            }
        });
        document.getElementById('submit-rating').disabled = false;
        document.getElementById('submit-rating').dataset.currentRating = rating;
    };

    const resetUserRatingUI = () => {
        updateStarsUI(0);
        const commentInput = document.getElementById('comment-input');
        const submitBtn = document.getElementById('submit-rating');
        if (commentInput) commentInput.value = '';
        if (submitBtn) {
            submitBtn.textContent = 'Submit';
            submitBtn.disabled = true;
            submitBtn.dataset.currentRating = 0;
        }
    };

    // --- Firestore Actions ---
    const handleSubmit = async () => {
        const submitBtn = document.getElementById('submit-rating');
        const rating = parseInt(submitBtn.dataset.currentRating);
        const comment = document.getElementById('comment-input').value.trim();

        if (!rating || rating === 0) return;

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';

        const serviceRef = db.collection('poortjie').doc('services').collection(serviceKey).doc(serviceId);

        try {
            // Update the specific user's rating in the map
            const updatePayload = {};
            updatePayload[`ratings.${currentUser.uid}`] = {
                rating: rating,
                comment: comment,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            };

            await serviceRef.update(updatePayload);

            // Recalculate average and total count
            await updateOverallServiceRating(serviceId, serviceKey);

            closeModal();
            window.location.replace(window.location.href);
        } catch (error) {
            console.error("Error submitting rating:", error);
            alert('Failed to save rating. Try again.');
            submitBtn.disabled = false;
        }
    };

    const updateOverallServiceRating = async (sId, sKey) => {
        const serviceRef = db.collection('poortjie').doc('services').collection(sKey).doc(sId);

        return db.runTransaction(async transaction => {
            const doc = await transaction.get(serviceRef);
            if (!doc.exists) return;

            const provider = doc.data();
            const ratingsMap = provider.ratings || {};

            const ratingsArray = Object.values(ratingsMap);
            const totalRatings = ratingsArray.length;
            const sumOfRatings = ratingsArray.reduce((acc, r) => acc + r.rating, 0);
            const newAverage = totalRatings > 0 ? (sumOfRatings / totalRatings) : 0;

            const updatePayload = {
                rating: newAverage,
                ratingCount: totalRatings
            };

            transaction.update(serviceRef, updatePayload);
        });
    };

    // Initialize fetching the modal template
    const modalPath = window.location.pathname.includes('/services/') ? 'rating-modal.html' : 'services/rating-modal.html';
    fetch(modalPath)
        .then(response => response.text())
        .then(html => {
            ratingModal.innerHTML = html;
            initializeModal();
        }).catch(error => console.error('Error fetching rating modal:', error));
});